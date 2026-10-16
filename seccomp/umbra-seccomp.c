// umbra-seccomp: emits the seccomp BPF program that bwrap installs on the
// sandboxed process tree (bwrap --seccomp <fd>).
//
//   umbra-seccomp [--allow-userns] > filter.bpf
//
// Default action is ALLOW; this is a denylist of kernel attack surface that
// no coding agent needs, modeled on Docker's and Flatpak's default profiles.
// Everything here is *in addition to* what the namespaces already enforce
// (no caps, no_new_privs, private mount/pid/ipc namespaces).
//
// --allow-userns keeps nested user namespaces available. Only needed for
// tools that drive Chromium with its own namespace sandbox (agy browser
// automation); for everything else, user namespaces are the single largest
// source of unprivileged-to-root kernel exploits and are blocked.
//
// Syscalls from a non-native ABI (ia32 int 0x80, x32) hit libseccomp's
// default bad-arch action (KILL), so the filter cannot be sidestepped by
// switching ABIs.

#define _GNU_SOURCE
#include <errno.h>
#include <sched.h>
#include <seccomp.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

#ifndef TIOCSTI
#define TIOCSTI 0x5412
#endif
#ifndef TIOCLINUX
#define TIOCLINUX 0x541C
#endif

static int deny(scmp_filter_ctx ctx, const char *name, int err) {
    int nr = seccomp_syscall_resolve_name(name);
    if (nr == __NR_SCMP_ERROR) {
        return 0;  // syscall doesn't exist on this arch; nothing to block
    }
    int rc = seccomp_rule_add(ctx, SCMP_ACT_ERRNO(err), nr, 0);
    if (rc < 0) {
        fprintf(stderr, "umbra-seccomp: rule for %s failed: %s\n", name, strerror(-rc));
    }
    return rc;
}

int main(int argc, char **argv) {
    int allow_userns = 0;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--allow-userns") == 0) {
            allow_userns = 1;
        } else {
            fprintf(stderr, "usage: %s [--allow-userns] > filter.bpf\n", argv[0]);
            return 2;
        }
    }
    if (isatty(STDOUT_FILENO)) {
        fprintf(stderr, "umbra-seccomp: refusing to write binary BPF to a terminal\n");
        return 2;
    }

    scmp_filter_ctx ctx = seccomp_init(SCMP_ACT_ALLOW);
    if (!ctx) {
        fprintf(stderr, "umbra-seccomp: seccomp_init failed\n");
        return 1;
    }

    // Kernel modules, kexec, reboot, swap, clock, accounting, quotas.
    static const char *eperm[] = {
        "init_module", "finit_module", "delete_module", "create_module",
        "query_module", "get_kernel_syms",
        "kexec_load", "kexec_file_load", "reboot",
        "swapon", "swapoff",
        "settimeofday", "clock_settime", "clock_adjtime", "adjtimex", "stime",
        "acct", "quotactl", "quotactl_fd", "nfsservctl", "uselib", "_sysctl",
        "sysfs", "syslog", "lookup_dcookie",
        // Raw hardware / legacy VM86.
        "ioperm", "iopl", "vm86", "vm86old",
        // Mount API: bwrap has already built the mount tree; nothing inside
        // the sandbox may reshape it.
        "mount", "umount", "umount2", "pivot_root", "move_mount", "open_tree",
        "fsopen", "fsmount", "fsconfig", "fspick", "mount_setattr",
        // Kernel keyrings are not namespaced per sandbox.
        "add_key", "request_key", "keyctl",
        // eBPF, perf, userfaultfd: frequent exploit primitives.
        "bpf", "perf_event_open", "userfaultfd",
        // Classic container breakout (file handle -> arbitrary inode).
        "open_by_handle_at",
        // Joining other namespaces via /proc/<pid>/ns fds.
        "setns",
        NULL,
    };
    for (const char **s = eperm; *s; s++) {
        if (deny(ctx, *s, EPERM) < 0) goto fail;
    }

    // io_uring has had a long run of LPE bugs and bypasses seccomp for the
    // operations it performs. ENOSYS (not EPERM) so libuv/Bun/Go silently
    // fall back to their thread-pool I/O paths.
    static const char *enosys[] = {"io_uring_setup", "io_uring_enter", "io_uring_register", NULL};
    for (const char **s = enosys; *s; s++) {
        if (deny(ctx, *s, ENOSYS) < 0) goto fail;
    }

    // Terminal input injection into the host shell. The host kernel already
    // has dev.tty.legacy_tiocsti=0 on recent kernels; this makes it hold
    // regardless of sysctl state. The ioctl request is an unsigned int, so
    // compare only the low 32 bits.
    if (seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(ioctl), 1,
                         SCMP_A1(SCMP_CMP_MASKED_EQ, 0xFFFFFFFFu, TIOCSTI)) < 0) goto fail;
    if (seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(ioctl), 1,
                         SCMP_A1(SCMP_CMP_MASKED_EQ, 0xFFFFFFFFu, TIOCLINUX)) < 0) goto fail;

    if (!allow_userns) {
        if (seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(unshare), 1,
                             SCMP_A0(SCMP_CMP_MASKED_EQ, CLONE_NEWUSER, CLONE_NEWUSER)) < 0) goto fail;
        // x86_64 clone(): flags are the first argument.
        if (seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(clone), 1,
                             SCMP_A0(SCMP_CMP_MASKED_EQ, CLONE_NEWUSER, CLONE_NEWUSER)) < 0) goto fail;
        // clone3() passes flags inside a struct seccomp can't inspect.
        // ENOSYS makes glibc/musl/Go fall back to clone(), which is filtered
        // above. This is the same trick Flatpak uses.
        if (deny(ctx, "clone3", ENOSYS) < 0) goto fail;
    }

    if (seccomp_export_bpf(ctx, STDOUT_FILENO) < 0) {
        fprintf(stderr, "umbra-seccomp: export failed\n");
        goto fail;
    }
    seccomp_release(ctx);
    return 0;

fail:
    seccomp_release(ctx);
    return 1;
}
