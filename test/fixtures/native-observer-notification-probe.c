#define _GNU_SOURCE
#include <errno.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <poll.h>
#include <sched.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#ifndef SECCOMP_FILTER_FLAG_WAIT_KILLABLE_RECV
#define SECCOMP_FILTER_FLAG_WAIT_KILLABLE_RECV (1UL << 5)
#endif

/* Test-only trusted participants. No trapped namespace operation is continued. */
static volatile sig_atomic_t signal_count;
static int64_t deadline;

static void interrupted(int signal_number) {
  if (signal_number == SIGUSR1) ++signal_count;
}

static int64_t now_ms(void) {
  struct timespec value;
  if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) return -1;
  return (int64_t)value.tv_sec * 1000 + value.tv_nsec / 1000000;
}

static int ready(int fd, short events) {
  for (;;) {
    int64_t remaining = deadline - now_ms();
    if (remaining <= 0) { errno = ETIMEDOUT; return -1; }
    struct pollfd item = { .fd = fd, .events = events };
    int result = poll(&item, 1, (int)remaining);
    if (result < 0 && errno == EINTR) continue;
    if (result <= 0) { if (result == 0) errno = ETIMEDOUT; return -1; }
    if (item.revents & (POLLERR | POLLNVAL)) { errno = EIO; return -1; }
    return item.revents;
  }
}

static int send_listener(int socket, int listener) {
  char byte = 'L';
  struct iovec iov = { .iov_base = &byte, .iov_len = 1 };
  union { struct cmsghdr alignment; char bytes[CMSG_SPACE(sizeof(int))]; } control;
  memset(&control, 0, sizeof(control));
  struct msghdr message = { .msg_iov = &iov, .msg_iovlen = 1,
    .msg_control = control.bytes, .msg_controllen = sizeof(control.bytes) };
  struct cmsghdr *header = CMSG_FIRSTHDR(&message);
  header->cmsg_level = SOL_SOCKET;
  header->cmsg_type = SCM_RIGHTS;
  header->cmsg_len = CMSG_LEN(sizeof(int));
  memcpy(CMSG_DATA(header), &listener, sizeof(listener));
  return sendmsg(socket, &message, MSG_NOSIGNAL) == 1 ? 0 : -1;
}

static int receive_listener(int socket) {
  if (ready(socket, POLLIN) < 0) return -1;
  char byte = 0;
  struct iovec iov = { .iov_base = &byte, .iov_len = 1 };
  union { struct cmsghdr alignment; char bytes[CMSG_SPACE(sizeof(int))]; } control;
  memset(&control, 0, sizeof(control));
  struct msghdr message = { .msg_iov = &iov, .msg_iovlen = 1,
    .msg_control = control.bytes, .msg_controllen = sizeof(control.bytes) };
  if (recvmsg(socket, &message, MSG_CMSG_CLOEXEC) != 1) return -1;
  struct cmsghdr *header = CMSG_FIRSTHDR(&message);
  if (byte != 'L' || message.msg_flags & (MSG_TRUNC | MSG_CTRUNC) ||
      header == NULL || header->cmsg_level != SOL_SOCKET ||
      header->cmsg_type != SCM_RIGHTS || header->cmsg_len != CMSG_LEN(sizeof(int)) ||
      CMSG_NXTHDR(&message, header) != NULL) { errno = EPROTO; return -1; }
  int listener;
  memcpy(&listener, CMSG_DATA(header), sizeof(listener));
  return listener;
}

static int install_filter(void) {
  struct sock_filter instructions[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_unshare, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_USER_NOTIF),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog filter = {
    .len = (unsigned short)(sizeof(instructions) / sizeof(instructions[0])),
    .filter = instructions,
  };
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return -1;
  return (int)syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER,
    SECCOMP_FILTER_FLAG_NEW_LISTENER | SECCOMP_FILTER_FLAG_WAIT_KILLABLE_RECV, &filter);
}

static void child_run(int socket, int cancelled, pid_t parent) {
  if (prctl(PR_SET_PDEATHSIG, SIGKILL) != 0 || getppid() != parent) _exit(20);
  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = interrupted; /* Deliberately no SA_RESTART. */
  if (sigemptyset(&action.sa_mask) != 0 || sigaction(SIGUSR1, &action, NULL) != 0) _exit(21);
  sigset_t unblocked;
  if (sigemptyset(&unblocked) != 0 || sigaddset(&unblocked, SIGUSR1) != 0 ||
      sigprocmask(SIG_UNBLOCK, &unblocked, NULL) != 0) _exit(21);
  int listener = install_filter();
  if (listener < 0) { dprintf(STDERR_FILENO, "filter setup errno=%d\n", errno); _exit(22); }
  if (prctl(PR_GET_SECCOMP, 0, 0, 0, 0) != SECCOMP_MODE_FILTER ||
      prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) != 1 || send_listener(socket, listener) != 0) _exit(23);
  if (close(listener) != 0) _exit(24);
  errno = 0;
  if (syscall(SYS_unshare, CLONE_NEWUSER) != -1 || errno != EPERM) _exit(25);
  char positive = 'P';
  if (send(socket, &positive, 1, MSG_NOSIGNAL) != 1) _exit(26);
  errno = 0;
  long result = syscall(SYS_unshare, CLONE_NEWUSER);
  int observed_errno = errno;
  if (result != -1 || observed_errno != (cancelled ? EINTR : EPERM) ||
      signal_count != (cancelled ? 1 : 0)) _exit(27);
  char observed = cancelled ? 'I' : 'R';
  if (send(socket, &observed, 1, MSG_NOSIGNAL) != 1 || close(socket) != 0) _exit(28);
  _exit(0);
}

static int answer_request(int listener, pid_t child) {
  struct seccomp_notif_sizes sizes;
  if (syscall(SYS_seccomp, SECCOMP_GET_NOTIF_SIZES, 0, &sizes) != 0) return -1;
  if (sizes.seccomp_notif < sizeof(struct seccomp_notif) || sizes.seccomp_notif > 4096 ||
      sizes.seccomp_notif_resp < sizeof(struct seccomp_notif_resp) || sizes.seccomp_notif_resp > 4096) {
    errno = EOVERFLOW; return -1;
  }
  struct seccomp_notif *request = calloc(1, sizes.seccomp_notif);
  struct seccomp_notif_resp *response = calloc(1, sizes.seccomp_notif_resp);
  if (request == NULL || response == NULL) { free(request); free(response); return -1; }
  int result = -1;
  if (ioctl(listener, SECCOMP_IOCTL_NOTIF_RECV, request) != 0) goto done;
  if (request->pid != (uint32_t)child || request->flags != 0 ||
      request->data.arch != AUDIT_ARCH_X86_64 || request->data.nr != SYS_unshare ||
      request->data.args[0] != CLONE_NEWUSER) { errno = EPROTO; goto done; }
  response->id = request->id;
  response->error = -EPERM;
  result = ioctl(listener, SECCOMP_IOCTL_NOTIF_SEND, response);
done:
  free(request);
  free(response);
  return result;
}

static int receive_byte(int socket, char expected) {
  if (ready(socket, POLLIN) < 0) return -1;
  char observed = 0;
  if (recv(socket, &observed, 1, 0) != 1 || observed != expected) { errno = EPROTO; return -1; }
  return 0;
}

static int reap(pid_t child, int *status) {
  for (;;) {
    pid_t result = waitpid(child, status, WNOHANG);
    if (result == child) return 0;
    if (result < 0 && errno != EINTR) return -1;
    if (now_ms() >= deadline) { errno = ETIMEDOUT; return -1; }
    (void)poll(NULL, 0, 5);
  }
}

int main(int argc, char **argv) {
  if (argc != 2 || (strcmp(argv[1], "cancelled") != 0 && strcmp(argv[1], "received") != 0)) return 2;
  if (getuid() == 0 || geteuid() == 0) { fputs("root is unsupported\n", stderr); return 2; }
  int cancelled = strcmp(argv[1], "cancelled") == 0;
  int64_t start = now_ms();
  if (start < 0) return 2;
  deadline = start + 7000;
  int sockets[2];
  if (socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, sockets) != 0) return 2;
  pid_t parent = getpid();
  pid_t child = fork();
  if (child == 0) { close(sockets[0]); child_run(sockets[1], cancelled, parent); }
  close(sockets[1]);
  if (child < 0) { close(sockets[0]); return 2; }
  int listener = -1;
  int status = 0;
  int reaped = 0;
  const char *stage = "listener handoff";
  listener = receive_listener(sockets[0]);
  if (listener < 0) goto fail;
  stage = "positive request";
  int readiness = ready(listener, POLLIN);
  if (readiness < 0 || !(readiness & POLLIN) || answer_request(listener, child) != 0 ||
      receive_byte(sockets[0], 'P') != 0) goto fail;
  stage = "second request queued";
  readiness = ready(listener, POLLIN);
  if (readiness < 0 || !(readiness & POLLIN)) goto fail;
  stage = "second request disposition";
  /* Cancellation mode never calls NOTIF_RECV for this queued request. */
  if (cancelled ? kill(child, SIGUSR1) != 0 : answer_request(listener, child) != 0) goto fail;
  if (receive_byte(sockets[0], cancelled ? 'I' : 'R') != 0) goto fail;
  stage = "child settlement";
  if (reap(child, &status) != 0) goto fail;
  reaped = 1;
  if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) { errno = ECHILD; goto fail; }
  stage = "terminal listener state";
  struct pollfd terminal = { .fd = listener, .events = POLLIN };
  if (poll(&terminal, 1, 0) != 1 || terminal.revents != POLLHUP) { errno = EPROTO; goto fail; }
  if (close(listener) != 0 || close(sockets[0]) != 0) return 2;
  printf("{\"mode\":\"%s\",\"filterApplied\":true,\"waitKillableRecv\":true,"
    "\"positiveReceived\":true,\"secondQueued\":true,\"secondReceived\":%s,"
    "\"caughtEintr\":%s,\"normalExit\":true,\"queueEmpty\":true,\"listenerHangup\":true}\n",
    argv[1], cancelled ? "false" : "true", cancelled ? "true" : "false");
  return ferror(stdout) ? 2 : 0;
fail:
  fprintf(stderr, "probe failed stage=%s errno=%d status=%d\n", stage, errno, status);
  if (!reaped) {
    (void)kill(child, SIGKILL);
    deadline = now_ms() + 1000;
    if (reap(child, &status) != 0) fputs("child settlement unconfirmed\n", stderr);
  }
  if (listener >= 0) close(listener);
  close(sockets[0]);
  return 1;
}
