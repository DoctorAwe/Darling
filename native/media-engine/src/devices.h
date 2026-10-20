#pragma once
#include <nlohmann/json.hpp>

// Device inspection activates IAudioClient to query mix format only.
// No capture/render stream is initialized or started by enumeration.
nlohmann::json enumerate_devices();
