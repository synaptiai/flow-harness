#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "observer-result.h"

/* Portable ABI controls only. This process has no result-channel custody role. */
static uint32_t get_le32(const unsigned char *bytes) {
  return (uint32_t)bytes[0] | ((uint32_t)bytes[1] << 8) |
    ((uint32_t)bytes[2] << 16) | ((uint32_t)bytes[3] << 24);
}

static int memory_controls(void) {
  unsigned char frame[66], correlation[32];
  memset(frame, 0xa5, sizeof(frame));
  memset(correlation, 0x37, sizeof(correlation));
  if (flow_observer_encode_result(NULL, 64, correlation, 32, 1, 0, 0, 0) != -1 ||
      flow_observer_encode_result(frame + 1, 64, NULL, 32, 1, 0, 0, 0) != -1 ||
      flow_observer_encode_result(frame + 1, 63, correlation, 32, 1, 0, 0, 0) != -1 ||
      flow_observer_encode_result(frame + 1, 65, correlation, 32, 1, 0, 0, 0) != -1 ||
      flow_observer_encode_result(frame + 1, 64, correlation, 31, 1, 0, 0, 0) != -1 ||
      flow_observer_encode_result(frame + 1, 64, correlation, 33, 1, 0, 0, 0) != -1)
    return 3;
  for (size_t i = 0; i < sizeof(frame); ++i) if (frame[i] != 0xa5) return 3;
  /* Correlation may overlap output; encoding must capture it before publishing. */
  if (flow_observer_encode_result(frame + 1, 64, frame + 1, 32, 1, 255, 0, 1) != 0)
    return 3;
  if (frame[0] != 0xa5 || frame[65] != 0xa5 || memcmp(frame + 1, "FLOWOBS1", 8) != 0)
    return 3;
  for (size_t i = 9; i < 41; ++i) if (frame[i] != 0xa5) return 3;
  if (get_le32(frame + 41) != 1 || get_le32(frame + 45) != 255 ||
      get_le32(frame + 49) != 0 || get_le32(frame + 53) != 1) return 3;
  for (size_t i = 57; i < 65; ++i) if (frame[i] != 0) return 3;
  return puts("memory-ok") < 0 ? 3 : 0;
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "memory") == 0) return memory_controls();
  if (argc != 3 || strcmp(argv[1], "encode") != 0) return 2;
  FILE *input = fopen(argv[2], "rb");
  if (input == NULL) return 2;
  unsigned char request[48], response[65];
  size_t count = 0, length;
  while ((length = fread(request, 1, sizeof(request), input)) != 0) {
    if (length != sizeof(request) || ++count > 1024) { fclose(input); return 2; }
    memset(response, 0xa5, sizeof(response));
    int result = flow_observer_encode_result(response + 1, 64, request + 16, 32,
      get_le32(request), get_le32(request + 4), get_le32(request + 8), get_le32(request + 12));
    if (result != 0 && result != -1) { fclose(input); return 3; }
    response[0] = result == 0 ? 0 : 1;
    if (fwrite(response, 1, sizeof(response), stdout) != sizeof(response)) { fclose(input); return 2; }
  }
  if (ferror(input) || fclose(input) != 0 || count == 0 || fflush(stdout) != 0) return 2;
  return 0;
}
