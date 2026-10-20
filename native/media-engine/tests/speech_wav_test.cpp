#include "speech_wav.h"
#include <iostream>

int main() {
  try {
    const std::vector<unsigned char> valid{
      'R','I','F','F',40,0,0,0,'W','A','V','E',
      'f','m','t',' ',16,0,0,0,1,0,1,0,128,187,0,0,0,119,1,0,2,0,16,0,
      'd','a','t','a',4,0,0,0,0,128,0,64};
    const auto samples = decode_speech_wav(valid);
    if (samples.size()!=2 || samples[0]!=-1.f || samples[1]!=.5f) throw std::runtime_error("PCM conversion");
    unsigned rejected = 0;
    auto reject = [&](const auto& bytes) {
      try { decode_speech_wav(bytes); } catch (const std::runtime_error&) { ++rejected; return; }
      throw std::runtime_error("Invalid WAV accepted");
    };
    for (size_t size=0; size<valid.size(); ++size) reject(std::span(valid).first(size));
    for (size_t index : {0u,8u,20u,22u,24u,28u,32u,34u,40u}) {
      auto bad = valid; bad[index] = 255; reject(bad);
    }
    auto junk = valid;
    junk.insert(junk.begin()+12, {'J','U','N','K',1,0,0,0,7,0}); junk[4] += 10;
    if (decode_speech_wav(junk) != samples) throw std::runtime_error("Odd chunk padding");
    auto duplicate = valid;
    duplicate.insert(duplicate.end(),valid.begin()+36,valid.end()); duplicate[4] += 12;
    reject(duplicate);
    std::cout << "PASS WAV decoding, odd chunk padding, rejected=" << rejected << '\n';
  } catch (const std::exception& e) { std::cerr << e.what(); return 1; }
}
