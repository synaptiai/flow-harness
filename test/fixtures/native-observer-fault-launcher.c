/* Trusted TEST launcher, never a production helper or application substitute.
 * Compile statically for Linux x64 and insert only at the exact post-rewrite
 * bootstrap helper position INSIDE the already-admitted bwrap invocation:
 *   launcher MODE /absolute/helper --flow-observer-v1 CORRELATION -- APP ARGS...
 * The runtime test must preserve every bwrap option and bootstrap script byte.
 *
 * Modes: passthrough; deny-exec; deny-exec-write; deny-exec-write-kill;
 * close-app-fd. The latter validates the live application descriptor and canary
 * before closing FD 4, producing a genuinely absent-descriptor control.
 *
 * FD 8 is deliberately coupled to observer-application.h's checked topology:
 * close_range(5..UINT_MAX), report pipe 5/6, then worker error pipe 7/8.
 * An implementation change requires recalibration, not a weaker assertion.
 * Passthrough MUST yield normal exit 7 and no inherited canary in the app;
 * denial modes MUST yield exec_failed EPERM, signalled SIGKILL, and signalled
 * SIGILL respectively. Signals remain launch-unproven. These controls do not
 * establish policy cleanliness or qualify arbitrary applications.
 */
#define _GNU_SOURCE
#if !defined(__linux__) || !defined(__x86_64__) || defined(__ILP32__)
#error "Native observer fault controls require Linux x64"
#endif

#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

extern char **environ;

static int mode_number(const char *name) {
    static const char *const names[] = {
        "passthrough", "deny-exec", "deny-exec-write",
        "deny-exec-write-kill", "close-app-fd"
    };
    for (unsigned int i = 0; i < sizeof(names) / sizeof(names[0]); ++i)
        if (strcmp(name, names[i]) == 0) return (int)i;
    return -1;
}

static int same_inode(const struct stat *a, const struct stat *b) {
    return a->st_dev == b->st_dev && a->st_ino == b->st_ino;
}

static int topology(void) {
    struct stat application, canary, result, own_pid_namespace, init_pid_namespace;
    const int canary_flags = fcntl(19, F_GETFD);
    const int application_flags = fcntl(4, F_GETFD);
    const int application_access = fcntl(4, F_GETFL);
    const int result_flags = fcntl(3, F_GETFD);
    const int result_access = fcntl(3, F_GETFL);
    if (canary_flags < 0 || (canary_flags & FD_CLOEXEC) != 0 ||
        application_flags < 0 || (application_flags & FD_CLOEXEC) != 0 ||
        application_access < 0 || (application_access & O_ACCMODE) != O_RDONLY ||
        result_flags < 0 || (result_flags & FD_CLOEXEC) != 0 || result_access < 0 ||
        (result_access & O_ACCMODE) == O_RDONLY ||
        fstat(4, &application) != 0 || !S_ISREG(application.st_mode) ||
        fstat(19, &canary) != 0 || !S_ISREG(canary.st_mode) ||
        !same_inode(&application, &canary) || fstat(3, &result) != 0 ||
        (!S_ISFIFO(result.st_mode) && !S_ISSOCK(result.st_mode))) return -1;
    for (int fd = 0; fd < 3; ++fd)
        if (fcntl(fd, F_GETFD) < 0) return -1;

    /* This is a calibration for the pinned bwrap profile, not generic namespace
     * detection or authentication. An outside-bwrap placement must fail before
     * the armed marker. The separate positive control checks the entire path. */
    if (getpid() <= 1 || stat("/proc/self/ns/pid", &own_pid_namespace) != 0 ||
        stat("/proc/1/ns/pid", &init_pid_namespace) != 0 ||
        !same_inode(&own_pid_namespace, &init_pid_namespace)) return -1;
    const int comm = open("/proc/1/comm", O_RDONLY | O_CLOEXEC);
    if (comm < 0) return -1;
    char name[32];
    const ssize_t length = read(comm, name, sizeof(name));
    const int closed = close(comm);
    return length == 6 && memcmp(name, "bwrap\n", 6) == 0 && closed == 0 ? 0 : -1;
}

static int install_filter(int mode) {
    struct sock_filter filters[24];
    unsigned short count = 0;
#define STMT(code, value) \
    do { filters[count++] = (struct sock_filter)BPF_STMT(code, value); } while (0)
#define JUMP(code, value, yes, no) \
    do { filters[count++] = (struct sock_filter)BPF_JUMP(code, value, yes, no); } while (0)
    STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch));
    JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0);
    STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS);
    STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr));
    /* Reject x32 instead of letting its syscall-number bit bypass a denial. */
    JUMP(BPF_JMP | BPF_JSET | BPF_K, UINT32_C(0x40000000), 0, 1);
    STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS);
    if (mode >= 1 && mode <= 3) {
        JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_execveat, 0, 1);
        STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM);
    }
    if (mode == 2 || mode == 3) {
        JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_write, 0, 3);
        /* write's fd is an int: compare the low 32 bits, not a guessed pointer. */
        STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0]));
        JUMP(BPF_JMP | BPF_JEQ | BPF_K, 8, 0, 1);
        STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM);
    }
    if (mode == 3) {
        STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr));
        JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_kill, 0, 1);
        STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM);
    }
    STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW);
#undef STMT
#undef JUMP
    const struct sock_fprog program = { .len = count, .filter = filters };
    return prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == 0 &&
        prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program) == 0 ? 0 : -1;
}

static int write_all(const char *text) {
    size_t remaining = strlen(text);
    while (remaining != 0) {
        const ssize_t written = write(STDERR_FILENO, text, remaining);
        if (written < 0 && errno == EINTR) continue;
        if (written <= 0) return -1;
        text += written;
        remaining -= (size_t)written;
    }
    return 0;
}

int main(int argc, char **argv) {
    if (argc < 7 || argc > 71 || argv[2][0] != '/' ||
        strcmp(argv[3], "--flow-observer-v1") != 0 ||
        strlen(argv[4]) != 64 || strcmp(argv[5], "--") != 0 || argv[6][0] != '/') return 120;
    const int mode = mode_number(argv[1]);
    if (mode < 0) return 120;
    for (unsigned int i = 0; i < 64; ++i)
        if (!((argv[4][i] >= '0' && argv[4][i] <= '9') ||
              (argv[4][i] >= 'a' && argv[4][i] <= 'f'))) return 120;
    if (topology() != 0 || install_filter(mode) != 0) return 121;
    if (mode == 4 && close(4) != 0) return 121;
    if (write_all("flow-observer-fault:") != 0 || write_all(argv[1]) != 0 ||
        write_all(":canary=live-regular-matches-app\n") != 0) return 121;
    /* execve is intentionally permitted: only the actual helper's application
     * execveat is denied. The original helper and its invocation are preserved. */
    execve(argv[2], &argv[2], environ);
    return 122;
}
