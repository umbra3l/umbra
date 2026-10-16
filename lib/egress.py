#!/usr/bin/env python3
"""umbra egress proxy -- the only way out of an umbra VM in net modes ask/strict.

One instance per sandbox session, running on the host (outside the VM and its
jail). The VM's network namespace can reach nothing except this proxy (pasta
forwards one loopback port to it), so every connection the agent makes is a
CONNECT (HTTPS) or absolute-URI request (HTTP) that is decided here:

  1. IP-literal or name that resolves to a non-public address -> deny
     (the agent can never use this proxy to reach your LAN, router, cloud
     metadata or this laptop's own loopback services)
  2. deny lists (defaults + yours)                           -> deny, quietly
  3. allow lists (defaults + yours + this session's)         -> allow
  4. mode "strict"                                           -> deny
  5. mode "ask": desktop notification
       [Allow once]  allowed for the rest of this session
       [Always allow <domain>]  appended to ~/.config/umbra/egress/allow
       [Deny] / dismissed / 60 s timeout  denied (dismiss/timeout re-asks
       after a cooldown; Deny holds for the session)
     Concurrent requests for the same host share one prompt, and at most
     three prompts are open at once, so a looping agent can't flood you.

The connection is made to the exact address that was checked (no second DNS
lookup), which closes DNS-rebinding races. Only ports 80/443 are treated as
ordinary; any other port is asked about as host:port.

Usage: egress.py --tool NAME --mode ask|strict --port-file F --log F
                 --list-dir DIR [--user-dir DIR]
"""

import argparse
import asyncio
import datetime
import ipaddress
import os
import re
import shutil
import signal
import socket
import sys
import time

STD_PORTS = {80, 443}
PROMPT_TIMEOUT = 60
MAX_OPEN_PROMPTS = 3
COOLDOWN = 30
HEAD_LIMIT = 65536
CONNECT_TIMEOUT = 15

# Second-level labels under which registrable domains sit one level deeper
# (example.co.uk). A heuristic, used only to word the "Always allow" button.
SLD_UNDER_CCTLD = {"co", "com", "net", "org", "gov", "ac", "edu", "or", "ne", "go"}

HOST_RE = re.compile(r"^[a-z0-9_]([a-z0-9_-]{0,62}\.)*[a-z0-9_-]{1,63}\.?$")


def now_iso():
    return datetime.datetime.now().isoformat(timespec="seconds")


def base_domain(host):
    labels = host.split(".")
    if len(labels) >= 3 and len(labels[-1]) == 2 and labels[-2] in SLD_UNDER_CCTLD:
        return ".".join(labels[-3:])
    return ".".join(labels[-2:]) if len(labels) >= 2 else host


def load_list(path):
    entries = set()
    try:
        with open(path) as f:
            for line in f:
                line = line.split("#", 1)[0].strip().lower()
                if not line:
                    continue
                line = line.removeprefix("*.").lstrip(".")
                entries.add(line)
    except FileNotFoundError:
        pass
    return entries


def matches(host, port, entries):
    """host[:port] matches an entry if it equals it or is a subdomain of it.
    Entries without a port only cover the standard ports."""
    for e in entries:
        if ":" in e:
            eh, _, ep = e.rpartition(":")
            if str(port) != ep:
                continue
        else:
            eh = e
            if port not in STD_PORTS:
                continue
        if host == eh or host.endswith("." + eh):
            return True
    return False


class Lists:
    """Default + user lists, reloaded when the user files change (so
    `umbra allow example.com` takes effect in running sessions)."""

    def __init__(self, list_dir, user_dir):
        self.files = {
            "allow": [os.path.join(list_dir, "defaults.allow"), os.path.join(user_dir, "allow")],
            "deny": [os.path.join(list_dir, "defaults.deny"), os.path.join(user_dir, "deny")],
        }
        self.user_allow = os.path.join(user_dir, "allow")
        self._stamp = None
        self.allow = set()
        self.deny = set()
        self.refresh()

    def _mtimes(self):
        out = []
        for paths in self.files.values():
            for p in paths:
                try:
                    out.append(os.stat(p).st_mtime_ns)
                except FileNotFoundError:
                    out.append(0)
        return tuple(out)

    def refresh(self):
        stamp = self._mtimes()
        if stamp == self._stamp:
            return
        self._stamp = stamp
        self.allow = set().union(*(load_list(p) for p in self.files["allow"]))
        self.deny = set().union(*(load_list(p) for p in self.files["deny"]))

    def add_always(self, entry):
        os.makedirs(os.path.dirname(self.user_allow), exist_ok=True)
        if entry in load_list(self.user_allow):
            return
        with open(self.user_allow, "a") as f:
            f.write(f"{entry}    # added {now_iso()} via prompt\n")
        self.refresh()


class Proxy:
    def __init__(self, args):
        self.tool = args.tool
        self.mode = args.mode
        self.lists = Lists(args.list_dir, args.user_dir)
        self.log_path = args.log
        self.session_allow = set()
        self.session_deny = set()
        self.cooldown = {}
        self.pending = {}
        self.open_prompts = 0
        self.logged = set()
        self.notify = shutil.which("notify-send")

    # ------------------------------------------------------------ logging --
    def log(self, verdict, key, reason, once=False):
        if once:
            tag = (verdict, key)
            if tag in self.logged:
                return
            self.logged.add(tag)
        line = f"{now_iso()} {self.tool:<9} {verdict:<5} {key}  ({reason})\n"
        try:
            with open(self.log_path, "a") as f:
                f.write(line)
        except OSError:
            pass

    # ------------------------------------------------------------- policy --
    async def decide(self, host, port):
        """Returns (allowed, reason, addrinfo-list)."""
        host = host.lower().rstrip(".")
        key = host if port in STD_PORTS else f"{host}:{port}"
        self.lists.refresh()

        try:
            ip = ipaddress.ip_address(host.strip("[]"))
        except ValueError:
            ip = None
        if ip is None and not HOST_RE.match(host):
            return False, "malformed host", None
        if ip is not None and not ip.is_global:
            return False, "private address", None

        if matches(host, port, self.lists.deny):
            return False, "denylist", None
        if key in self.session_deny:
            return False, "denied earlier this session", None

        if key in self.session_allow:
            reason = "allowed this session"
        elif matches(host, port, self.lists.allow):
            reason = "allowlist"
        elif self.mode == "strict":
            return False, "not on allowlist (strict mode)", None
        else:
            until = self.cooldown.get(key, 0)
            if time.monotonic() < until:
                return False, "prompt dismissed recently", None
            ok, reason = await self.ask(host, port, key)
            if not ok:
                return False, reason, None

        # Resolve here and pin the connection to what we checked.
        try:
            loop = asyncio.get_running_loop()
            infos = await loop.getaddrinfo(host.strip("[]"), port, type=socket.SOCK_STREAM)
        except socket.gaierror as e:
            return False, f"DNS: {e.strerror}", None
        for info in infos:
            addr = ipaddress.ip_address(info[4][0].split("%")[0])
            if not addr.is_global:
                return False, f"resolves to non-public {addr}", None
        return True, reason, infos

    async def ask(self, host, port, key):
        if key in self.pending:
            return await asyncio.shield(self.pending[key])
        if not self.notify:
            return False, "no notification daemon to ask (use: umbra allow)"
        if self.open_prompts >= MAX_OPEN_PROMPTS:
            return False, "too many open prompts"
        fut = asyncio.get_running_loop().create_future()
        self.pending[key] = fut
        self.open_prompts += 1
        try:
            result = await self._prompt(host, port, key)
        finally:
            self.open_prompts -= 1
            del self.pending[key]
        fut.set_result(result)
        return result

    async def _prompt(self, host, port, key):
        base = base_domain(host) if port in STD_PORTS else key
        target = host if port in STD_PORTS else f"{host}:{port}"
        try:
            proc = await asyncio.create_subprocess_exec(
                self.notify,
                "--app-name=umbra",
                "--urgency=critical",
                f"--expire-time={PROMPT_TIMEOUT * 1000}",
                "--icon=network-wired",
                "--action=once=Allow once",
                f"--action=always=Always allow {base}",
                "--action=deny=Deny",
                f"umbra · {self.tool} wants to connect",
                target,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                start_new_session=True,
            )
            try:
                out, _ = await asyncio.wait_for(proc.communicate(), PROMPT_TIMEOUT + 5)
            except asyncio.TimeoutError:
                proc.kill()
                out = b""
        except OSError:
            return False, "notify-send failed"
        choice = out.decode(errors="replace").strip()
        if choice == "once":
            self.session_allow.add(key)
            return True, "you allowed it for this session"
        if choice == "always":
            self.lists.add_always(base)
            self.session_allow.add(key)
            return True, f"you always-allowed {base}"
        if choice == "deny":
            self.session_deny.add(key)
            return False, "you denied it"
        self.cooldown[key] = time.monotonic() + COOLDOWN
        return False, "prompt dismissed or timed out"

    # ---------------------------------------------------------- transport --
    async def open_upstream(self, infos):
        last = None
        for family, type_, proto, _, sockaddr in infos:
            try:
                return await asyncio.wait_for(
                    asyncio.open_connection(sockaddr[0], sockaddr[1]), CONNECT_TIMEOUT
                )
            except (OSError, asyncio.TimeoutError) as e:
                last = e
        raise last or OSError("no address")

    @staticmethod
    async def pipe(reader, writer):
        try:
            while True:
                data = await reader.read(65536)
                if not data:
                    break
                writer.write(data)
                await writer.drain()
        except (ConnectionError, OSError, asyncio.CancelledError):
            pass
        finally:
            try:
                if writer.can_write_eof():
                    writer.write_eof()
            except (OSError, RuntimeError):
                pass

    @staticmethod
    async def refuse(writer, code, text, reason):
        body = f"Blocked by umbra: {reason}\n".encode()
        writer.write(
            f"HTTP/1.1 {code} {text}\r\nContent-Type: text/plain\r\n"
            f"Content-Length: {len(body)}\r\nX-Umbra-Reason: {reason}\r\n"
            f"Connection: close\r\n\r\n".encode() + body
        )
        try:
            await writer.drain()
        except OSError:
            pass
        writer.close()

    async def handle(self, reader, writer):
        try:
            head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 30)
        except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, asyncio.TimeoutError, OSError):
            writer.close()
            return
        try:
            request_line, *header_lines = head.decode("latin-1").split("\r\n")
            method, target, version = request_line.split(" ", 2)
        except ValueError:
            await self.refuse(writer, 400, "Bad Request", "malformed request")
            return

        if method.upper() == "CONNECT":
            host, port = self.split_hostport(target, 443)
            if host is None:
                await self.refuse(writer, 400, "Bad Request", "bad CONNECT target")
                return
            ok, reason, infos = await self.decide(host, port)
            key = host if port in STD_PORTS else f"{host}:{port}"
            if not ok:
                self.log("DENY", key, reason)
                await self.refuse(writer, 403, "Forbidden", reason)
                return
            try:
                up_r, up_w = await self.open_upstream(infos)
            except (OSError, asyncio.TimeoutError) as e:
                self.log("FAIL", key, f"connect: {e}")
                await self.refuse(writer, 502, "Bad Gateway", "upstream unreachable")
                return
            self.log("ALLOW", key, reason, once=True)
            writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            await writer.drain()
        else:
            m = re.match(r"^http://([^/]+)(/.*)?$", target, re.I)
            if not m:
                await self.refuse(writer, 400, "Bad Request", "only absolute http:// URLs or CONNECT")
                return
            host, port = self.split_hostport(m.group(1), 80)
            if host is None:
                await self.refuse(writer, 400, "Bad Request", "bad host")
                return
            path = m.group(2) or "/"
            ok, reason, infos = await self.decide(host, port)
            key = host if port in STD_PORTS else f"{host}:{port}"
            if not ok:
                self.log("DENY", key, reason)
                await self.refuse(writer, 403, "Forbidden", reason)
                return
            try:
                up_r, up_w = await self.open_upstream(infos)
            except (OSError, asyncio.TimeoutError) as e:
                self.log("FAIL", key, f"connect: {e}")
                await self.refuse(writer, 502, "Bad Gateway", "upstream unreachable")
                return
            self.log("ALLOW", key, reason, once=True)
            kept = [
                h for h in header_lines
                if h and not h.lower().startswith(("proxy-connection:", "proxy-authorization:", "connection:"))
            ]
            up_w.write(
                (f"{method} {path} {version}\r\n" + "\r\n".join(kept) + "\r\nConnection: close\r\n\r\n").encode("latin-1")
            )
            await up_w.drain()

        await asyncio.gather(self.pipe(reader, up_w), self.pipe(up_r, writer))
        for w in (writer, up_w):
            try:
                w.close()
            except OSError:
                pass

    @staticmethod
    def split_hostport(text, default_port):
        text = text.strip()
        if text.startswith("["):
            end = text.find("]")
            if end < 0:
                return None, None
            host, rest = text[1 : end], text[end + 1 :]
            port = int(rest[1:]) if rest.startswith(":") and rest[1:].isdigit() else default_port
            return host, port
        host, sep, port = text.rpartition(":")
        if sep and port.isdigit():
            return host, int(port)
        return text, default_port


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tool", required=True)
    ap.add_argument("--mode", choices=["ask", "strict"], default="ask")
    ap.add_argument("--port-file", required=True)
    ap.add_argument("--log", required=True)
    ap.add_argument("--list-dir", required=True)
    ap.add_argument("--user-dir", default=os.path.expanduser("~/.config/umbra/egress"))
    ap.add_argument("--parent-pid", type=int, default=0, help="exit when this process is gone")
    args = ap.parse_args()

    os.makedirs(os.path.dirname(args.log), exist_ok=True)
    proxy = Proxy(args)
    server = await asyncio.start_server(proxy.handle, "127.0.0.1", 0, limit=HEAD_LIMIT, backlog=256)
    port = server.sockets[0].getsockname()[1]
    tmp = args.port_file + ".tmp"
    with open(tmp, "w") as f:
        f.write(f"{port}\n")
    os.replace(tmp, args.port_file)

    # Exit with the session: the launcher kills our process group, and we
    # also notice if it vanishes without doing so (killed, SIGPIPE, ...).
    parent = args.parent_pid or os.getppid()
    loop = asyncio.get_running_loop()
    stop = loop.create_future()
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        loop.add_signal_handler(sig, lambda: stop.done() or stop.set_result(None))

    def alive(pid):
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            return True

    async def watch_parent():
        while not stop.done():
            if not alive(parent):
                stop.set_result(None)
                return
            await asyncio.sleep(1)

    asyncio.ensure_future(watch_parent())
    await stop
    # Don't wait for open tunnels to drain (Server.wait_closed() would block
    # on connections from a VM that no longer exists): the session is over.
    os._exit(0)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
