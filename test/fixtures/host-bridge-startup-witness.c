/* Test-only startup witness, executed as PID 1 in a private bwrap PID namespace.
 * CLI: witness observe|release|live-residue|zombie-residue GUARDIAN RELAY UNIX TCP
 * Never signals a discovered PID. Capture the no-child observation immediately
 * after waiting for the exact owner, before draining pipes or namespace teardown.
 * The two calibration modes create real adopted children, not guardian receipts.
 * Exiting this PID 1 tears down leftovers AFTER the immutable observation.
 */
#define _GNU_SOURCE
#if !defined(__linux__) || !defined(__x86_64__) || defined(__ILP32__)
#error "Startup witness requires Linux x64"
#endif

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

extern char **environ;

static void expired(int signal_number) {
    (void)signal_number;
    _exit(124); /* PID 1 needs a caught alarm, not the default disposition. */
}

static long long milliseconds(void) {
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return -1;
    return (long long)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static int nonblocking(int fd) {
    const int flags = fcntl(fd, F_GETFL);
    return flags < 0 ? -1 : fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

static int read_output(int fd, unsigned char *buffer, size_t *length, int *closed) {
    if (*closed) return 0;
    unsigned char chunk[257];
    const ssize_t count = read(fd, chunk, sizeof(chunk));
    if (count == 0) { *closed = 1; return 0; }
    if (count < 0) return errno == EINTR || errno == EAGAIN ? 0 : -1;
    if (*length + (size_t)count > 256) return -1;
    memcpy(buffer + *length, chunk, (size_t)count);
    *length += (size_t)count;
    return 0;
}

/* Exactly one non-reaping observation. A live child returns success with pid 0;
 * an exited, unreaped child returns a positive pid. Neither is ECHILD. */
static const char *remaining_children(void) {
    siginfo_t information;
    memset(&information, 0, sizeof(information));
    const int result = waitid(P_ALL, 0, &information, WEXITED | WNOHANG | WNOWAIT);
    if (result < 0) return errno == ECHILD ? "none" : NULL;
    return information.si_pid == 0 ? "live" : "unreaped";
}

static void residue_owner(int zombie) {
    int ready[2];
    if (pipe2(ready, O_CLOEXEC) != 0) _exit(111);
    const pid_t child = fork();
    if (child < 0) _exit(112);
    if (child == 0) {
        if (close(ready[0]) != 0 || write(ready[1], "R", 1) != 1 ||
            close(ready[1]) != 0) _exit(113);
        /* Residue must not hold the owner's output pipes open. */
        if (close(0) != 0 || close(1) != 0 || close(2) != 0) _exit(114);
        if (zombie) _exit(7);
        for (;;) pause();
    }
    unsigned char byte;
    if (close(ready[1]) != 0 || read(ready[0], &byte, 1) != 1 || byte != 'R' ||
        close(ready[0]) != 0) _exit(115);
    if (zombie) {
        siginfo_t information;
        memset(&information, 0, sizeof(information));
        if (waitid(P_PID, (id_t)child, &information, WEXITED | WNOWAIT) != 0 ||
            information.si_pid != child || information.si_code != CLD_EXITED ||
            information.si_status != 7) _exit(116);
    }
    _exit(1); /* Leave the real live/zombie child for adoption by the witness. */
}

static void print_hex(const unsigned char *bytes, size_t length) {
    for (size_t i = 0; i < length; ++i) printf("%02x", bytes[i]);
}

int main(int argc, char **argv) {
    if (argc != 6 || getpid() != 1 || argv[2][0] != '/' || argv[3][0] != '/') return 120;
    const int release = strcmp(argv[1], "release") == 0;
    const int live = strcmp(argv[1], "live-residue") == 0;
    const int zombie = strcmp(argv[1], "zombie-residue") == 0;
    if (!release && !live && !zombie && strcmp(argv[1], "observe") != 0) return 120;
    struct sigaction action;
    memset(&action, 0, sizeof(action));
    sigset_t empty;
    if (sigemptyset(&empty) != 0 || sigemptyset(&action.sa_mask) != 0) return 120;
    action.sa_handler = SIG_DFL;
    if (sigaction(SIGCHLD, &action, NULL) != 0) return 120;
    action.sa_handler = expired;
    if (sigaction(SIGALRM, &action, NULL) != 0) return 120;
    action.sa_handler = SIG_IGN;
    if (sigaction(SIGPIPE, &action, NULL) != 0 ||
        sigprocmask(SIG_SETMASK, &empty, NULL) != 0) return 120;
    alarm(8);
    int subreaper = 0, parent_death_signal = 0;
    if (prctl(PR_SET_CHILD_SUBREAPER, 1) != 0 ||
        prctl(PR_GET_CHILD_SUBREAPER, &subreaper) != 0 || subreaper != 1 ||
        prctl(PR_GET_PDEATHSIG, &parent_death_signal) != 0 || parent_death_signal != SIGKILL ||
        syscall(SYS_close_range, 3u, UINT_MAX, 0u) != 0 || nonblocking(0) != 0 ||
        nonblocking(1) != 0) return 120;
    int control[2], output[2], diagnostic[2];
    if (pipe2(control, O_CLOEXEC) != 0 || pipe2(output, O_CLOEXEC) != 0 ||
        pipe2(diagnostic, O_CLOEXEC) != 0) return 121;
    const pid_t owner = fork();
    if (owner < 0) return 121;
    if (owner == 0) {
        if (dup2(control[0], 0) != 0 || dup2(output[1], 1) != 1 ||
            dup2(diagnostic[1], 2) != 2 ||
            syscall(SYS_close_range, 3u, UINT_MAX, 0u) != 0) _exit(117);
        if (live || zombie) residue_owner(zombie);
        execve(argv[2], &argv[2], environ);
        _exit(118);
    }
    if (close(control[0]) != 0 || close(output[1]) != 0 || close(diagnostic[1]) != 0 ||
        nonblocking(output[0]) != 0 || nonblocking(diagnostic[0]) != 0) return 121;
    const long long start = milliseconds();
    if (start < 0) return 121;
    unsigned char out[256], err[256], command[6];
    size_t out_length = 0, err_length = 0, command_length = 0;
    int out_closed = 0, err_closed = 0, owner_closed = 0, control_closed = 0, status = 0;
    const char *remaining = NULL;
    for (;;) {
        if (!owner_closed) {
            const pid_t waited = waitpid(owner, &status, WNOHANG);
            if (waited == owner) {
                /* No other wait, pipe drain, signal, or teardown before this sample. */
                remaining = remaining_children();
                if (remaining == NULL) return 122;
                owner_closed = 1;
            } else if (waited < 0 && errno != EINTR) return 122;
        }
        if (read_output(output[0], out, &out_length, &out_closed) != 0 ||
            read_output(diagnostic[0], err, &err_length, &err_closed) != 0) return 122;
        if (owner_closed && out_closed && err_closed) break;
        if (release && !control_closed) {
            const ssize_t count = read(0, command + command_length, sizeof(command) - command_length);
            if (count > 0) {
                command_length += (size_t)count;
                if (command_length > 5 || memcmp(command, "stop\n", command_length) != 0) return 122;
            } else if (count == 0) {
                if (command_length != 5 || write(control[1], command, 5) != 5 ||
                    close(control[1]) != 0) return 122;
                control_closed = 1;
            } else if (errno != EAGAIN && errno != EINTR) return 122;
        }
        const long long now = milliseconds();
        if (now < 0 || now - start >= 6000) return 124;
        if (poll(NULL, 0, 2) < 0 && errno != EINTR) return 122;
    }
    if (close(output[0]) != 0 || close(diagnostic[0]) != 0 ||
        (!control_closed && close(control[1]) != 0)) return 122;
    if (!WIFEXITED(status) && !WIFSIGNALED(status)) return 122;
    printf("{\"ownerCode\":%d,\"ownerSignal\":%d,\"stdoutHex\":\"",
           WIFEXITED(status) ? WEXITSTATUS(status) : -1,
           WIFSIGNALED(status) ? WTERMSIG(status) : 0);
    print_hex(out, out_length);
    printf("\",\"stderrHex\":\"");
    print_hex(err, err_length);
    printf("\",\"remaining\":\"%s\"}\n", remaining);
    if (fflush(stdout) != 0 || ferror(stdout)) return 123;
    return 0; /* Namespace cleanup cannot revise the already captured observation. */
}
