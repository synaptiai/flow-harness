#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <inttypes.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/fsuid.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

/* Trusted synthetic test participant, run ONLY inside production SRT. No host
 * namespace operations, privileged provisioning, or idmapped mount qualification. */
static void fail(const char *stage) {
  fprintf(stderr, "group probe failed: %s errno=%d\n", stage, errno);
  exit(2);
}

static void path_for(char *out, size_t size, const char *root, const char *tail) {
  int n = snprintf(out, size, "%s/%s", root, tail);
  if (n < 0 || (size_t)n >= size) fail("path bound");
}

static int write_mapping(const char *path, const char *bytes) {
  int fd = open(path, O_WRONLY | O_CLOEXEC);
  if (fd < 0) return errno;
  size_t size = strlen(bytes);
  ssize_t n = write(fd, bytes, size);
  int error = n == (ssize_t)size ? 0 : (n < 0 ? errno : EIO);
  if (close(fd) != 0 && error == 0) error = errno;
  return error;
}

static void read_small(const char *path, char *out, size_t size) {
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) fail("metadata open");
  ssize_t n = read(fd, out, size - 1);
  if (n < 0 || (size_t)n == size - 1 || close(fd) != 0) fail("metadata read");
  out[n] = '\0';
}

static void map_json(const char *bytes) {
  unsigned long first, lower, count;
  char extra;
  /* These specific SRT and test-created namespaces must have one mapping only. */
  if (sscanf(bytes, "%lu %lu %lu %c", &first, &lower, &count, &extra) != 3) fail("map shape");
  printf("[[%lu,%lu,%lu]]", first, lower, count);
}

static int read_fixture(const char *root, const char *tail, const char *expected) {
  char path[4096];
  path_for(path, sizeof(path), root, tail);
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return errno;
  char bytes[64];
  ssize_t n = read(fd, bytes, sizeof(bytes));
  int error = n < 0 ? errno : 0;
  if (close(fd) != 0 && error == 0) error = errno;
  if (error == 0 && (n != (ssize_t)strlen(expected) || memcmp(bytes, expected, (size_t)n) != 0)) fail("fixture bytes");
  return error;
}

static void read_arm(const char *root, int out[4]) {
  out[0] = read_fixture(root, "denied.txt", "synthetic-denied");
  out[1] = read_fixture(root, "blocked/child.txt", "synthetic-denied");
  out[2] = read_fixture(root, "missing.txt", "");
  out[3] = read_fixture(root, "accessible.txt", "synthetic-accessible");
}

static int map_attempt(unsigned long group) {
  pid_t child = fork();
  if (child < 0) fail("map fork");
  if (child == 0) {
    if (unshare(CLONE_NEWUSER) != 0) _exit(200);
    if (write_mapping("/proc/self/setgroups", "deny") != 0) _exit(201);
    char mapping[96];
    snprintf(mapping, sizeof(mapping), "0 %lu 1\n", group);
    int error = write_mapping("/proc/self/gid_map", mapping);
    _exit(error < 128 ? error : 202);
  }
  int status;
  pid_t result;
  do { result = waitpid(child, &status, 0); } while (result < 0 && errno == EINTR);
  if (result != child || !WIFEXITED(status)) fail("map settlement");
  return WEXITSTATUS(status);
}

static void arm_json(const char *root, const int before[4], gid_t outer_gid) {
  char path[4096];
  path_for(path, sizeof(path), root, "denied.txt");
  struct stat info;
  if (lstat(path, &info) != 0) fail("fixture stat");
  int chmod_error = chmod(path, 0600) == 0 ? 0 : errno;
  int chgrp_error = chown(path, (uid_t)-1, getegid()) == 0 ? 0 : errno;
  int after[4];
  read_arm(root, after);
  printf("{\"before\":[%d,%d,%d,%d],\"after\":[%d,%d,%d,%d],\"chmod\":%d,\"chgrp\":%d,\"fileGid\":%ju,\"outerFileGid\":%ju}",
    before[0], before[1], before[2], before[3], after[0], after[1], after[2], after[3], chmod_error, chgrp_error, (uintmax_t)info.st_gid, (uintmax_t)outer_gid);
}

int main(int argc, char **argv) {
  if (argc != 5 || getuid() == 0 || geteuid() != getuid() || getgid() != getegid()) fail("arguments or outer identity");
  char *end;
  errno = 0;
  unsigned long secondary = strtoul(argv[3], &end, 10);
  if (errno || *end || secondary == 0 || secondary == 65534 || secondary > UINT32_MAX) fail("secondary identity");
  char outer_map[1024], nested_map[1024], outer_uid[1024], nested_uid[1024], status[4096];
  char old_namespace[128], new_namespace[128], old_mount[128], new_mount[128];
  read_small("/proc/self/gid_map", outer_map, sizeof(outer_map));
  read_small("/proc/self/uid_map", outer_uid, sizeof(outer_uid));
  ssize_t old_n = readlink("/proc/self/ns/user", old_namespace, sizeof(old_namespace));
  ssize_t old_m = readlink("/proc/self/ns/mnt", old_mount, sizeof(old_mount));
  uid_t uid = geteuid();
  gid_t gid = getegid();
  int outer_user_fd = open("/proc/self/ns/user", O_RDONLY | O_CLOEXEC);
  int outer_mount_fd = open("/proc/self/ns/mnt", O_RDONLY | O_CLOEXEC);
  char stat_path[4096];
  struct stat primary_stat, secondary_stat;
  path_for(stat_path, sizeof(stat_path), argv[1], "primary/denied.txt");
  if (lstat(stat_path, &primary_stat) != 0) fail("outer primary stat");
  path_for(stat_path, sizeof(stat_path), argv[1], "secondary/denied.txt");
  if (lstat(stat_path, &secondary_stat) != 0 || outer_user_fd < 0 || outer_mount_fd < 0) fail("outer fixture or namespace handle");
  if (old_n <= 0 || (size_t)old_n >= sizeof(old_namespace) || old_m <= 0 || (size_t)old_m >= sizeof(old_mount)) fail("outer namespace");
  if (unshare(CLONE_NEWUSER) != 0) fail("nested user namespace");
  if (write_mapping("/proc/self/setgroups", "deny") != 0) fail("nested setgroups denial");
  char mapping[96];
  snprintf(mapping, sizeof(mapping), "0 %ju 1\n", (uintmax_t)uid);
  if (write_mapping("/proc/self/uid_map", mapping) != 0) fail("nested uid mapping");
  snprintf(mapping, sizeof(mapping), "0 %ju 1\n", (uintmax_t)gid);
  if (write_mapping("/proc/self/gid_map", mapping) != 0) fail("nested gid mapping");
  if (unshare(CLONE_NEWNS) != 0 || mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL) != 0) fail("private mount namespace");
  ssize_t new_n = readlink("/proc/self/ns/user", new_namespace, sizeof(new_namespace));
  ssize_t new_m = readlink("/proc/self/ns/mnt", new_mount, sizeof(new_mount));
  if (new_n <= 0 || (size_t)new_n >= sizeof(new_namespace) || getuid() != 0 || getgid() != 0 || (old_n == new_n && memcmp(old_namespace, new_namespace, (size_t)new_n) == 0)) fail("nested namespace identity");
  if (new_m <= 0 || (size_t)new_m >= sizeof(new_mount) || (old_m == new_m && memcmp(old_mount, new_mount, (size_t)new_m) == 0)) fail("nested mount identity");
  read_small("/proc/self/gid_map", nested_map, sizeof(nested_map));
  read_small("/proc/self/uid_map", nested_uid, sizeof(nested_uid));
  read_small("/proc/self/status", status, sizeof(status));
  char *cap_line = strstr(status, "\nCapEff:\t");
  char caps[17], extra;
  if (cap_line == NULL || sscanf(cap_line, "\nCapEff:\t%16[0-9a-f]%c", caps, &extra) != 2 || extra != '\n') fail("capability mask");
  char primary[4096], foreign[4096];
  path_for(primary, sizeof(primary), argv[1], "primary");
  path_for(foreign, sizeof(foreign), argv[1], "secondary");
  int primary_before[4], secondary_before[4];
  read_arm(primary, primary_before);
  read_arm(foreign, secondary_before);
  int private_fd = open(argv[4], O_RDONLY | O_CLOEXEC);
  int private_read = private_fd < 0 ? errno : 0;
  if (private_fd >= 0 && close(private_fd) != 0) fail("private close");
  int groups_error = setgroups(0, NULL) == 0 ? 0 : errno;
  int gid_error = setresgid((gid_t)-1, (gid_t)secondary, (gid_t)-1) == 0 ? 0 : errno;
  int fsgid_before = setfsgid((gid_t)-1);
  (void)setfsgid((gid_t)secondary);
  int fsgid_after = setfsgid((gid_t)-1);
  int setns_user = setns(outer_user_fd, CLONE_NEWUSER) == 0 ? 0 : errno;
  if (setns_user == 0) fail("unexpected ancestor user namespace entry");
  int setns_mount = setns(outer_mount_fd, CLONE_NEWNS) == 0 ? 0 : errno;
  if (setns_mount == 0) fail("unexpected ancestor mount namespace entry");
  if (close(outer_user_fd) != 0 || close(outer_mount_fd) != 0) fail("namespace handle close");
  int map_current = map_attempt(0), map_secondary = map_attempt(secondary), map_overflow = map_attempt(65534);
  int bind_error = mount(argv[1], argv[2], NULL, MS_BIND, NULL) == 0 ? 0 : errno;
  int remount_error = bind_error == 0 ? (mount(NULL, argv[2], NULL, MS_REMOUNT | MS_BIND, NULL) == 0 ? 0 : errno) : -1;
  int alias_primary[4], alias_secondary[4];
  char alias_path[4096];
  path_for(alias_path, sizeof(alias_path), argv[2], "primary");
  read_arm(alias_path, alias_primary);
  path_for(alias_path, sizeof(alias_path), argv[2], "secondary");
  read_arm(alias_path, alias_secondary);
  printf("{\"outerGidMap\":"); map_json(outer_map);
  printf(",\"nestedGidMap\":"); map_json(nested_map);
  printf(",\"outerUidMap\":"); map_json(outer_uid);
  printf(",\"nestedUidMap\":"); map_json(nested_uid);
  printf(",\"namespaceChanged\":true,\"mountNamespaceChanged\":true,\"capEff\":\"%s\",\"primary\":", caps);
  arm_json(primary, primary_before, primary_stat.st_gid);
  printf(",\"secondary\":"); arm_json(foreign, secondary_before, secondary_stat.st_gid);
  printf(",\"aliasPrimary\":[%d,%d,%d,%d],\"aliasSecondary\":[%d,%d,%d,%d]", alias_primary[0], alias_primary[1], alias_primary[2], alias_primary[3], alias_secondary[0], alias_secondary[1], alias_secondary[2], alias_secondary[3]);
  printf(",\"privateRead\":%d,\"setgroups\":%d,\"setresgid\":%d,\"fsgidBefore\":%d,\"fsgidAfter\":%d,\"mapCurrent\":%d,\"mapSecondary\":%d,\"mapOverflow\":%d,\"bind\":%d,\"remount\":%d,\"setnsUser\":%d,\"setnsMount\":%d}\n",
    private_read, groups_error, gid_error, fsgid_before, fsgid_after, map_current, map_secondary, map_overflow, bind_error, remount_error, setns_user, setns_mount);
  return ferror(stdout) ? 2 : 0;
}
