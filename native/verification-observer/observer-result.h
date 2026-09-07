#ifndef FLOW_VERIFICATION_OBSERVER_RESULT_H
#define FLOW_VERIFICATION_OBSERVER_RESULT_H

#include <limits.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#define FLOW_OBSERVER_FRAME_BYTES 64u
#define FLOW_OBSERVER_CORRELATION_BYTES 32u

_Static_assert(CHAR_BIT == 8, "FLOWOBS1 requires 8-bit bytes");

/* Internal FLOWOBS1 ABI only. No descriptor ownership, transport completion,
 * launch, executable identity, signal provenance, or policy qualification is
 * established by encoding a frame. Correlation is not writer authentication.
 *
 * Exactly 64 output bytes and 32 correlation bytes are required. Returns 0 on
 * success, -1 on null pointers, invalid lengths, or invalid fields. Rejection leaves output
 * unchanged. As with other C buffer APIs, supplied pointers must designate the
 * declared accessible storage. Overlapping output/correlation is supported.
 * The caller owns correlation storage and must prevent concurrent mutation.
 */
static inline int flow_observer_encode_result(
    unsigned char *output, size_t output_size,
    const unsigned char *correlation, size_t correlation_size,
    uint32_t kind, uint32_t detail, uint32_t phase, uint32_t flags) {
  if (output == NULL || correlation == NULL ||
      output_size != FLOW_OBSERVER_FRAME_BYTES ||
      correlation_size != FLOW_OBSERVER_CORRELATION_BYTES || flags > 1u)
    return -1;

  int valid;
  switch (kind) {
    case 1u: valid = phase == 0u && detail <= 255u; break;
    case 2u: valid = phase == 0u && detail >= 1u && detail <= 64u; break;
    case 3u: valid = phase >= 1u && phase <= 4u && detail >= 1u && detail <= 4095u; break;
    case 4u: valid = phase == 0u && detail >= 1u && detail <= 4095u; break;
    case 5u: valid = phase == 0u && detail == 0u; break;
    case 6u: valid = (phase == 4u || phase == 5u) && detail >= 1u && detail <= 4095u; break;
    default: valid = 0; break;
  }
  if (!valid) return -1;

  unsigned char frame[FLOW_OBSERVER_FRAME_BYTES] = {0};
  memcpy(frame, "FLOWOBS1", 8u);
  memcpy(frame + 8u, correlation, FLOW_OBSERVER_CORRELATION_BYTES);
  const uint32_t fields[4] = {kind, detail, phase, flags};
  for (size_t field = 0; field < 4u; ++field) {
    for (size_t byte = 0; byte < 4u; ++byte)
      frame[40u + field * 4u + byte] = (unsigned char)(fields[field] >> (byte * 8u));
  }
  memcpy(output, frame, sizeof(frame));
  return 0;
}

#endif
