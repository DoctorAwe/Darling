#pragma once

#include <cstdlib>
#include <stdexcept>

namespace darling::aec {

// WebRTC targets are commonly built with C++ exceptions disabled. The same
// sources also build in the standalone harness, where throwing is useful.
// Define DARLING_AEC_NO_EXCEPTIONS before including the AEC sources in a
// no-exceptions translation unit.
[[noreturn]] inline void Fail(const char* message) {
#ifdef DARLING_AEC_NO_EXCEPTIONS
  (void)message;
  std::abort();
#else
  throw std::invalid_argument(message);
#endif
}

}  // namespace darling::aec
