// umbra-init: runs as root inside the guest VM, before the tool.
//
//   umbra-init /run/umbra/vm.conf
//
// vm.conf is a NUL-separated list of KEY=VALUE records written by bin/umbra:
//   UID, GID           identity to drop to (yours)
//   HOME, WORKDIR      home and start directory
//   HOSTNAME           guest hostname
//   ENVFILE            NUL-separated KEY=VALUE environment for the tool
//   TMPFS              (repeatable) guest-local tmpfs mount points
//   USERRUN            the XDG_RUNTIME_DIR to create (tmpfs, 0700, owned by UID)
//   ARG                (repeatable) argv of the program to exec, in order
//
// Steps: raise RLIMIT_NOFILE, mount guest-local tmpfs dirs, set the
// hostname, then drop *all* privilege (supplementary groups, gid, uid,
// capability bounding set, no_new_privs) and exec the tool with exactly the
// environment from ENVFILE. Nothing from the kernel command line or
// libkrun's init environment is passed on.

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/capability.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#define MAX_ITEMS 4096

static void die(const char *what) {
    fprintf(stderr, "umbra-init: %s: %s\n", what, strerror(errno));
    _exit(126);
}

// Reads a whole file into a NUL-terminated buffer.
static char *slurp(const char *path, size_t *len) {
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) die(path);
    size_t cap = 65536, n = 0;
    char *buf = malloc(cap + 1);
    if (!buf) die("malloc");
    for (;;) {
        if (n == cap) {
            cap *= 2;
            buf = realloc(buf, cap + 1);
            if (!buf) die("realloc");
        }
        ssize_t r = read(fd, buf + n, cap - n);
        if (r < 0) {
            if (errno == EINTR) continue;
            die(path);
        }
        if (r == 0) break;
        n += (size_t)r;
    }
    close(fd);
    buf[n] = '\0';
    *len = n;
    return buf;
}

// Splits a NUL-separated buffer into records.
static int split(char *buf, size_t len, char **out, int max) {
    int count = 0;
    size_t i = 0;
    while (i < len && count < max) {
        char *rec = buf + i;
        size_t l = strlen(rec);
        if (l > 0) out[count++] = rec;
        i += l + 1;
    }
    return count;
}

static void mkdir_p(const char *path, mode_t mode) {
    char tmp[4096];
    if (snprintf(tmp, sizeof tmp, "%s", path) >= (int)sizeof tmp) return;
    for (char *p = tmp + 1; *p; p++) {
        if (*p == '/') {
            *p = '\0';
            mkdir(tmp, 0755);
            *p = '/';
        }
    }
    mkdir(tmp, mode);
}

int main(int argc, char **argv) {
    if (argc != 2) {
        fprintf(stderr, "usage: umbra-init <vm.conf>\n");
        return 2;
    }
    if (getuid() != 0) {
        fprintf(stderr, "umbra-init: must start as guest root\n");
        return 126;
    }

    size_t conf_len;
    char *conf = slurp(argv[1], &conf_len);
    char *recs[MAX_ITEMS];
    int nrec = split(conf, conf_len, recs, MAX_ITEMS);

    uid_t uid = 0;
    gid_t gid = 0;
    const char *home = "/", *workdir = NULL, *hostname = NULL, *envfile = NULL, *userrun = NULL;
    const char *tmpfs[64];
    int ntmpfs = 0;
    char *args[MAX_ITEMS];
    int nargs = 0;
    int have_uid = 0;

    for (int i = 0; i < nrec; i++) {
        char *eq = strchr(recs[i], '=');
        if (!eq) continue;
        *eq = '\0';
        const char *k = recs[i], *v = eq + 1;
        if (!strcmp(k, "UID")) { uid = (uid_t)strtoul(v, NULL, 10); have_uid = 1; }
        else if (!strcmp(k, "GID")) gid = (gid_t)strtoul(v, NULL, 10);
        else if (!strcmp(k, "HOME")) home = v;
        else if (!strcmp(k, "WORKDIR")) workdir = v;
        else if (!strcmp(k, "HOSTNAME")) hostname = v;
        else if (!strcmp(k, "ENVFILE")) envfile = v;
        else if (!strcmp(k, "USERRUN")) userrun = v;
        else if (!strcmp(k, "TMPFS") && ntmpfs < 64) tmpfs[ntmpfs++] = v;
        else if (!strcmp(k, "ARG") && nargs < MAX_ITEMS - 1) args[nargs++] = (char *)v;
    }
    args[nargs] = NULL;
    if (!have_uid || uid == 0) {
        fprintf(stderr, "umbra-init: refusing to run the tool as guest root\n");
        return 126;
    }
    if (nargs == 0) {
        fprintf(stderr, "umbra-init: no command\n");
        return 126;
    }

    // Generous fd limit: file watchers (opencode, language servers) need it.
    struct rlimit rl;
    if (getrlimit(RLIMIT_NOFILE, &rl) == 0) {
        rl.rlim_cur = rl.rlim_max = 1048576;
        if (setrlimit(RLIMIT_NOFILE, &rl) != 0) {
            rl.rlim_cur = rl.rlim_max = 524288;
            setrlimit(RLIMIT_NOFILE, &rl);
        }
    }

    for (int i = 0; i < ntmpfs; i++) {
        mkdir_p(tmpfs[i], 01777);
        if (mount("tmpfs", tmpfs[i], "tmpfs", MS_NOSUID | MS_NODEV, "mode=1777") != 0) die(tmpfs[i]);
    }
    if (userrun) {
        mkdir_p(userrun, 0700);
        if (mount("tmpfs", userrun, "tmpfs", MS_NOSUID | MS_NODEV, "mode=0700") != 0) die(userrun);
        if (chown(userrun, uid, gid) != 0) die("chown XDG_RUNTIME_DIR");
    }
    if (hostname && sethostname(hostname, strlen(hostname)) != 0) die("sethostname");

    // Environment for the tool: exactly ENVFILE.
    char *envbuf = NULL;
    size_t env_len = 0;
    char *envp[MAX_ITEMS];
    int nenv = 0;
    if (envfile) {
        envbuf = slurp(envfile, &env_len);
        nenv = split(envbuf, env_len, envp, MAX_ITEMS - 1);
    }
    envp[nenv] = NULL;

    if (chdir(workdir ? workdir : home) != 0 && chdir(home) != 0) die("chdir");

    // Drop privilege irreversibly.
    for (int cap = 0; cap <= 63; cap++) {
        if (prctl(PR_CAPBSET_DROP, cap, 0, 0, 0) != 0 && errno != EINVAL) die("capbset drop");
    }
    if (setgroups(0, NULL) != 0) die("setgroups");
    if (setresgid(gid, gid, gid) != 0) die("setresgid");
    if (setresuid(uid, uid, uid) != 0) die("setresuid");
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) die("no_new_privs");
    if (setuid(0) == 0) {
        fprintf(stderr, "umbra-init: privilege drop did not stick\n");
        _exit(126);
    }

    execve(args[0], args, envp);
    die(args[0]);
    return 126;
}
