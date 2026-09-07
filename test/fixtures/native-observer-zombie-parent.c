/* Host-only fixed zombie-versus-reaped calibration. Not an observer helper.
 * Compile statically for Linux x64. CLI: /absolute/this-binary HEX64.
 * The owned child execs this exact binary with argv[0]=HEX64, argv[1]=--child.
 * FD 3 is its owned command pipe; FD 4 is its post-exec acknowledgement pipe.
 * No caller-supplied PID is accepted, printed, or signalled.
 *
 * Protocol: stdout ready\n; stdin exit\n -> stdout zombie\n after WNOWAIT;
 * stdin reap\n -> stdout reaped\n after exact waitpid exit 7;
 * stdin quit\n -> parent exit 0. Wrong ordering/input fails with no success line.
 * Failure cleanup targets only the parent's still-owned, unreaped child.
 * A hard alarm and child parent-death signal bound abnormal lifetimes; host
 * qualification still owns retention when exact settlement is unconfirmed.
 */
#define _GNU_SOURCE
#if !defined(__linux__) || !defined(__x86_64__) || defined(__ILP32__)
#error "Native observer zombie controls require Linux x64"
#endif

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static int marker_valid(const char *text) {
    if (strlen(text) != 64) return 0;
    for (size_t i = 0; i < 64; ++i)
        if (!((text[i] >= '0' && text[i] <= '9') ||
              (text[i] >= 'a' && text[i] <= 'f'))) return 0;
    return 1;
}

static int checked_signals(void) {
    struct sigaction action;
    memset(&action, 0, sizeof(action));
    action.sa_handler = SIG_DFL;
    sigset_t empty;
    if (sigemptyset(&action.sa_mask) != 0 || sigemptyset(&empty) != 0 ||
        sigaction(SIGALRM, &action, NULL) != 0 ||
        sigaction(SIGCHLD, &action, NULL) != 0) return -1;
    action.sa_handler = SIG_IGN; // Broken owned pipes enter explicit cleanup.
    return sigaction(SIGPIPE, &action, NULL) == 0 &&
        sigprocmask(SIG_SETMASK, &empty, NULL) == 0 ? 0 : -1;
}

static long long milliseconds(void) {
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return -1;
    return (long long)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static int byte_read(int fd, unsigned char *byte, int budget) {
    const long long start = milliseconds();
    if (start < 0) return -1;
    for (;;) {
        const long long now = milliseconds();
        if (now < 0 || now - start >= budget) return -1;
        struct pollfd item = { .fd = fd, .events = POLLIN, .revents = 0 };
        const int ready = poll(&item, 1, budget - (int)(now - start));
        if (ready < 0 && errno == EINTR) continue;
        if (ready != 1 || (item.revents & (POLLERR | POLLNVAL)) != 0) return -1;
        const ssize_t received = read(fd, byte, 1);
        if (received == 1) return 0;
        if (received < 0 && (errno == EINTR || errno == EAGAIN)) continue;
        return -1;
    }
}

static int command(const char *expected) {
    /* Every fixed command, including its newline, must match byte-for-byte.
     * The process alarm bounds the whole protocol, not a fresh per-byte budget. */
    for (size_t i = 0; expected[i] != '\0'; ++i) {
        unsigned char byte;
        if (byte_read(STDIN_FILENO, &byte, 8000) != 0 || byte != (unsigned char)expected[i])
            return -1;
    }
    return 0;
}

static int line(const char *text) {
    const size_t length = strlen(text);
    return write(STDOUT_FILENO, text, length) == (ssize_t)length ? 0 : -1;
}

static int child_main(const char *marker) {
    int death_signal = 0;
    struct stat input, acknowledgement;
    if (!marker_valid(marker) || checked_signals() != 0 ||
        prctl(PR_GET_PDEATHSIG, &death_signal) != 0 || death_signal != SIGKILL ||
        getppid() <= 1 || fstat(3, &input) != 0 || !S_ISFIFO(input.st_mode) ||
        fstat(4, &acknowledgement) != 0 || !S_ISFIFO(acknowledgement.st_mode) ||
        (fcntl(3, F_GETFL) & O_ACCMODE) != O_RDONLY ||
        (fcntl(4, F_GETFL) & O_ACCMODE) != O_WRONLY) return 110;
    alarm(10);
    if (write(4, "R", 1) != 1 || close(4) != 0) return 111;
    unsigned char request;
    if (byte_read(3, &request, 9000) != 0 || request != 'E' || close(3) != 0) return 112;
    return 7;
}

/* Return -2 if the child is no longer ours, so failure handling never signals
 * a PID that could have been reused. WNOWAIT deliberately leaves the zombie. */
static int wait_owned(pid_t child, int preserve, int budget) {
    const long long start = milliseconds();
    if (start < 0) return -1;
    for (;;) {
        if (preserve) {
            siginfo_t information;
            memset(&information, 0, sizeof(information));
            if (waitid(P_PID, (id_t)child, &information, WEXITED | WNOHANG | WNOWAIT) != 0) {
                if (errno != EINTR) return errno == ECHILD ? -2 : -1;
            } else if (information.si_pid == child) {
                return information.si_code == CLD_EXITED && information.si_status == 7 ? 0 : -1;
            } else if (information.si_pid != 0) return -1;
        } else {
            int status = 0;
            const pid_t waited = waitpid(child, &status, WNOHANG);
            if (waited == child)
                return WIFEXITED(status) && WEXITSTATUS(status) == 7 ? 0 : 1;
            if (waited < 0 && errno != EINTR) return errno == ECHILD ? -2 : -1;
        }
        const long long now = milliseconds();
        if (now < 0 || now - start >= budget) return -1;
        const struct timespec pause = { .tv_sec = 0, .tv_nsec = 1000000 };
        if (nanosleep(&pause, NULL) != 0 && errno != EINTR) return -1;
    }
}

int main(int argc, char **argv) {
    if (argc == 2 && strcmp(argv[1], "--child") == 0) return child_main(argv[0]);
    if (argc != 2 || argv[0][0] != '/' || !marker_valid(argv[1]) || checked_signals() != 0)
        return 120;
    alarm(10);
    for (int fd = 0; fd < 3; ++fd)
        if (fcntl(fd, F_GETFD) < 0) return 120;
    const int input_flags = fcntl(STDIN_FILENO, F_GETFL);
    const int output_flags = fcntl(STDOUT_FILENO, F_GETFL);
    if (input_flags < 0 || output_flags < 0 ||
        fcntl(STDIN_FILENO, F_SETFL, input_flags | O_NONBLOCK) != 0 ||
        fcntl(STDOUT_FILENO, F_SETFL, output_flags | O_NONBLOCK) != 0 ||
        syscall(SYS_close_range, 3u, UINT_MAX, 0u) != 0) return 120;
    int commands[2] = {-1, -1}, acknowledgements[2] = {-1, -1};
    pid_t child = -1;
    int owned = 0, result = 121;
    if (pipe2(commands, O_CLOEXEC | O_NONBLOCK) != 0 ||
        pipe2(acknowledgements, O_CLOEXEC | O_NONBLOCK) != 0) goto cleanup;
    if (commands[0] != 3 || commands[1] != 4 ||
        acknowledgements[0] != 5 || acknowledgements[1] != 6) goto cleanup;
    const pid_t parent = getpid();
    child = fork();
    if (child < 0) goto cleanup;
    if (child == 0) {
        if (prctl(PR_SET_PDEATHSIG, SIGKILL) != 0 || getppid() != parent ||
            close(commands[1]) != 0 || fcntl(commands[0], F_SETFD, 0) != 0 ||
            dup2(acknowledgements[1], 4) != 4 ||
            syscall(SYS_close_range, 5u, UINT_MAX, 0u) != 0) _exit(113);
        char *arguments[] = {argv[1], "--child", NULL};
        char *environment[] = {"LANG=C", "LC_ALL=C", NULL};
        execve(argv[0], arguments, environment);
        _exit(114);
    }
    owned = 1;
    if (close(commands[0]) != 0) { commands[0] = -1; goto cleanup; }
    commands[0] = -1;
    if (close(acknowledgements[1]) != 0) { acknowledgements[1] = -1; goto cleanup; }
    acknowledgements[1] = -1;
    unsigned char ready;
    if (byte_read(acknowledgements[0], &ready, 1000) != 0 || ready != 'R') goto cleanup;
    if (close(acknowledgements[0]) != 0) { acknowledgements[0] = -1; goto cleanup; }
    acknowledgements[0] = -1;
    if (line("ready\n") != 0 || command("exit\n") != 0 ||
        write(commands[1], "E", 1) != 1) goto cleanup;
    if (close(commands[1]) != 0) { commands[1] = -1; goto cleanup; }
    commands[1] = -1;
    const int observed = wait_owned(child, 1, 1000);
    if (observed == -2) owned = 0;
    if (observed != 0 || line("zombie\n") != 0 || command("reap\n") != 0) goto cleanup;
    const int reaped = wait_owned(child, 0, 1000);
    if (reaped == 0 || reaped == 1 || reaped == -2) owned = 0;
    if (reaped != 0 || line("reaped\n") != 0 || command("quit\n") != 0) goto cleanup;
    result = 0;
cleanup:
    if (child > 0 && owned) {
        (void)kill(child, SIGKILL);
        (void)wait_owned(child, 0, 500);
    }
    for (size_t i = 0; i < 2; ++i) {
        if (commands[i] >= 0 && close(commands[i]) != 0) result = 121;
        if (acknowledgements[i] >= 0 && close(acknowledgements[i]) != 0) result = 121;
    }
    return result;
}
