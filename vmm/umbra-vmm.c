// umbra-vmm: boots one umbra microVM with libkrun.
//
//   umbra-vmm --root DIR --init PATH --conf PATH [--cpus N] [--ram MIB] [--log LEVEL]
//
// Runs as your uid *inside* the host-side bwrap jail (pid/ipc/user
// namespaces, no capabilities, seccomp, and -- in the networked modes -- a
// pasta network namespace with an nftables policy). Everything the guest can
// ever touch is the directory tree under --root, which bwrap assembled from
// explicit binds; the guest gets its own Linux kernel on top of KVM.
//
// Design notes:
//   * The root filesystem is a virtio-fs share with the DAX window disabled
//     (shm_size = 0). DAX's host/guest shared-memory mapping is what broke
//     SQLite WAL databases under ai-sandbox v1.
//   * Networking is libkrun's TSI (transparent socket impersonation): guest
//     sockets are proxied over vsock and re-created by this process, so they
//     are subject to whatever network namespace and firewall this process
//     sits in. There is no virtual NIC, bridge, or host-side tap device.
//   * Nothing secret is passed on the guest kernel command line (libkrun puts
//     the exec environment there, and the guest can read it back via dmesg).
//     The guest init reads its real configuration and environment from
//     files under --root instead.
//   * The console is libkrun's implicit console: when stdin is a terminal the
//     guest gets a real tty with window-size propagation and job control.
//   * If stdout is a pipe whose reader goes away (`umbra claude -p ... | head`),
//     libkrun ignores the EPIPE and the guest would block on its console
//     forever. A watchdog thread ends the VM instead, like SIGPIPE would.

#define _GNU_SOURCE
#include <errno.h>
#include <getopt.h>
#include <libkrun.h>
#include <poll.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

// Blocks until fd 1 reports an error/hangup (the reader of a pipe or socket
// closed), then exits with the shell's SIGPIPE status.
static void *stdout_watchdog(void *arg) {
    (void)arg;
    struct pollfd p = {.fd = STDOUT_FILENO, .events = 0, .revents = 0};
    for (;;) {
        int r = poll(&p, 1, -1);
        if (r < 0) {
            if (errno == EINTR) continue;
            return NULL;
        }
        if (p.revents & (POLLERR | POLLHUP | POLLNVAL)) _exit(141);
    }
}

static void start_stdout_watchdog(void) {
    struct stat st;
    if (isatty(STDOUT_FILENO) || fstat(STDOUT_FILENO, &st) != 0) return;
    if (!S_ISFIFO(st.st_mode) && !S_ISSOCK(st.st_mode)) return;
    pthread_t t;
    if (pthread_create(&t, NULL, stdout_watchdog, NULL) == 0) pthread_detach(t);
}

static void usage(const char *argv0) {
    fprintf(stderr,
            "usage: %s --root DIR --init PATH --conf PATH [--cpus N] [--ram MIB] [--log LEVEL]\n",
            argv0);
}

static int fail(const char *what, int rc) {
    fprintf(stderr, "umbra-vmm: %s failed: %s\n", what, strerror(rc < 0 ? -rc : rc));
    return 1;
}

int main(int argc, char **argv) {
    const char *root = NULL, *init = NULL, *conf = NULL;
    long cpus = 0, ram = 8192, log_level = 0;

    static const struct option opts[] = {
        {"root", required_argument, NULL, 'r'},
        {"init", required_argument, NULL, 'i'},
        {"conf", required_argument, NULL, 'c'},
        {"cpus", required_argument, NULL, 'p'},
        {"ram", required_argument, NULL, 'm'},
        {"log", required_argument, NULL, 'l'},
        {NULL, 0, NULL, 0},
    };
    int o;
    while ((o = getopt_long(argc, argv, "", opts, NULL)) != -1) {
        switch (o) {
        case 'r': root = optarg; break;
        case 'i': init = optarg; break;
        case 'c': conf = optarg; break;
        case 'p': cpus = strtol(optarg, NULL, 10); break;
        case 'm': ram = strtol(optarg, NULL, 10); break;
        case 'l': log_level = strtol(optarg, NULL, 10); break;
        default: usage(argv[0]); return 2;
        }
    }
    if (!root || !init || !conf || optind != argc) {
        usage(argv[0]);
        return 2;
    }

    int rc = krun_set_log_level((uint32_t)log_level);
    if (rc) return fail("krun_set_log_level", rc);

    int ctx = krun_create_ctx();
    if (ctx < 0) return fail("krun_create_ctx", ctx);

    int max_cpus = krun_get_max_vcpus();
    if (cpus <= 0) cpus = sysconf(_SC_NPROCESSORS_ONLN);
    if (max_cpus > 0 && cpus > max_cpus) cpus = max_cpus;
    if (cpus > 255) cpus = 255;
    if (cpus < 1) cpus = 1;
    if (ram < 512) ram = 512;

    if ((rc = krun_set_vm_config(ctx, (uint8_t)cpus, (uint32_t)ram))) return fail("krun_set_vm_config", rc);

    // Root share: no DAX window (SQLite-safe), writable (host-side bwrap
    // read-only binds still apply: the host kernel enforces them).
    if ((rc = krun_add_virtiofs3(ctx, KRUN_FS_ROOT_TAG, root, 0, false))) return fail("root virtiofs", rc);

    if ((rc = krun_set_workdir(ctx, "/"))) return fail("krun_set_workdir", rc);

    const char *const gargv[] = {conf, NULL};
    const char *const genv[] = {"UMBRA_VM=1", NULL};
    if ((rc = krun_set_exec(ctx, init, gargv, genv))) return fail("krun_set_exec", rc);

    start_stdout_watchdog();
    rc = krun_start_enter(ctx);
    // krun_start_enter only returns on failure; on success this process
    // exits with the guest workload's exit status.
    return fail("krun_start_enter", rc);
}
