#pragma once
#include <nlohmann/json.hpp>
#include <atomic>
#include <future>
#include <mutex>
#include <string>
#include <thread>
#include "audio_pipeline.h"

class Capture {
public:
  explicit Capture(AudioPipeline& pipeline) : pipeline_(pipeline) {}
  ~Capture();
  nlohmann::json start(const std::string& device_id);
  nlohmann::json stop();
  nlohmann::json status();
private:
  AudioPipeline& pipeline_;
  void run(std::string device_id, std::promise<std::string> initialized);
  std::thread worker_;
  std::atomic<bool> stop_{false}, running_{false};
  std::atomic<uint64_t> frames_{0}, discontinuities_{0}, clipped_{0}, timestamp_errors_{0};
  std::atomic<double> peak_{0}, rms_{0};
  std::mutex metadata_mutex_;
  nlohmann::json format_ = nullptr;
  std::string device_id_, error_, reason_ = "idle";
};
