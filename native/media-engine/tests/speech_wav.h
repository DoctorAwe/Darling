#pragma once
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <span>
#include <stdexcept>
#include <vector>

// Deliberately strict: no silent resampling, remixing, level normalization,
// compressed formats or WAVE_FORMAT_EXTENSIBLE interpretation.
inline std::vector<float> decode_speech_wav(std::span<const unsigned char> bytes) {
  auto fail = [] { throw std::runtime_error("Expected intact RIFF WAV, PCM16 mono 48000 Hz"); };
  auto u16 = [&](size_t i) -> uint32_t { return bytes[i] | (uint32_t(bytes[i+1]) << 8); };
  auto u32 = [&](size_t i) -> uint32_t { return u16(i) | (u16(i+2) << 16); };
  auto tag = [&](size_t i, const char* s) { return std::memcmp(bytes.data()+i, s, 4) == 0; };
  if (bytes.size() < 12 || !tag(0,"RIFF") || !tag(8,"WAVE")) fail();
  if (uint64_t(u32(4)) + 8 != bytes.size()) fail();
  bool format = false, data = false;
  size_t start = 0, length = 0;
  for (size_t p = 12; p < bytes.size();) {
    if (bytes.size()-p < 8) fail();
    const size_t size = u32(p+4), body = p+8;
    if (size > bytes.size()-body) fail();
    if (tag(p,"fmt ")) {
      if (format || size < 16) fail();
      if (u16(body)!=1 || u16(body+2)!=1 || u32(body+4)!=48000 ||
          u32(body+8)!=96000 || u16(body+12)!=2 || u16(body+14)!=16) fail();
      format = true;
    } else if (tag(p,"data")) {
      if (data || size == 0 || size%2) fail();
      data = true; start = body; length = size;
    }
    if ((size & 1) && body+size == bytes.size()) fail();
    p = body+size+(size & 1);
  }
  if (!format || !data) fail();
  std::vector<float> result(length/2);
  for (size_t i=0; i<result.size(); ++i) {
    const auto raw = u16(start+i*2);
    const int value = raw >= 32768 ? int(raw)-65536 : int(raw);
    result[i] = value / 32768.f;
  }
  return result;
}

inline std::vector<float> read_speech_wav(const std::filesystem::path& path) {
  std::ifstream file(path, std::ios::binary | std::ios::ate);
  if (!file) throw std::runtime_error("Cannot open WAV input");
  const auto size = file.tellg();
  if (size < 12 || size > 64*1024*1024) throw std::runtime_error("WAV size outside 12 B..64 MiB");
  std::vector<unsigned char> bytes(static_cast<size_t>(size));
  file.seekg(0);
  if (!file.read(reinterpret_cast<char*>(bytes.data()), bytes.size())) throw std::runtime_error("Truncated WAV read");
  return decode_speech_wav(bytes);
}
