#pragma once
#include "audio_pipeline.h"
#include <nlohmann/json.hpp>
#include <thread>
#include <future>
#include <mutex>
class Playback {
  AudioPipeline& pipeline_;
  std::thread worker_;
  std::atomic<bool> stop_{false}, running_{false};
  std::atomic<uint64_t> frames_{0};
  std::atomic<unsigned> padding_{0};
  std::mutex mutex_;
  std::string device_, reason_ = "idle", error_;
  double latencyMs_ = 0;
  void run(std::string device, std::promise<std::string> ready);
public:
  explicit Playback(AudioPipeline& pipeline) : pipeline_(pipeline) {}
  ~Playback();
  nlohmann::json start(const std::string& device);
  nlohmann::json stop();
  nlohmann::json status();
};
