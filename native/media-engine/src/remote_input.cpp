#include <windows.h>
#include <nlohmann/json.hpp>
#include <algorithm>
#include <iostream>
#include <map>
#include <string>
#include <vector>

using nlohmann::json;
constexpr size_t max_line = 16 * 1024;
static bool dry_run = false;
static std::vector<WORD> held_keys;
static bool held_buttons[3]{};

static void reply(const std::string& type, const std::string& request, const json& payload = json::object()) {
  std::cout << json{{"protocolVersion", 1}, {"requestId", request}, {"type", type}, {"payload", payload}}.dump() << '\n' << std::flush;
}
static void inject(INPUT& input) { if (!dry_run && SendInput(1, &input, sizeof(INPUT)) != 1) throw std::runtime_error("SendInput failed"); }
static void key(WORD vk, bool down) {
  INPUT input{}; input.type = INPUT_KEYBOARD; input.ki.wVk = vk; input.ki.dwFlags = down ? 0 : KEYEVENTF_KEYUP; inject(input);
  auto it = std::find(held_keys.begin(), held_keys.end(), vk);
  if (down && it == held_keys.end()) held_keys.push_back(vk); else if (!down && it != held_keys.end()) held_keys.erase(it);
}
static void button(int index, bool down) {
  static constexpr DWORD flags[3][2] = {{MOUSEEVENTF_LEFTUP, MOUSEEVENTF_LEFTDOWN}, {MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MIDDLEDOWN}, {MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_RIGHTDOWN}};
  INPUT input{}; input.type = INPUT_MOUSE; input.mi.dwFlags = flags[index][down ? 1 : 0]; inject(input); held_buttons[index] = down;
}
static void release_all() {
  const auto keys = held_keys; for (WORD vk : keys) key(vk, false);
  for (int i = 0; i < 3; ++i) if (held_buttons[i]) button(i, false);
}
static WORD virtual_key(const std::string& code) {
  if (code.rfind("Key", 0) == 0 && code.size() == 4) return static_cast<WORD>(code[3]);
  if (code.rfind("Digit", 0) == 0 && code.size() == 6) return static_cast<WORD>(code[5]);
  static const std::map<std::string, WORD> keys = {
    {"Backspace",VK_BACK},{"Tab",VK_TAB},{"Enter",VK_RETURN},{"Escape",VK_ESCAPE},{"Space",VK_SPACE},{"Insert",VK_INSERT},{"Delete",VK_DELETE},{"Home",VK_HOME},{"End",VK_END},{"PageUp",VK_PRIOR},{"PageDown",VK_NEXT},
    {"ArrowLeft",VK_LEFT},{"ArrowUp",VK_UP},{"ArrowRight",VK_RIGHT},{"ArrowDown",VK_DOWN},{"ShiftLeft",VK_LSHIFT},{"ShiftRight",VK_RSHIFT},{"ControlLeft",VK_LCONTROL},{"ControlRight",VK_RCONTROL},{"AltLeft",VK_LMENU},{"AltRight",VK_RMENU},{"MetaLeft",VK_LWIN},{"MetaRight",VK_RWIN},{"CapsLock",VK_CAPITAL},{"NumLock",VK_NUMLOCK},{"ScrollLock",VK_SCROLL},
    {"NumpadAdd",VK_ADD},{"NumpadSubtract",VK_SUBTRACT},{"NumpadMultiply",VK_MULTIPLY},{"NumpadDivide",VK_DIVIDE},{"NumpadDecimal",VK_DECIMAL},{"NumpadEnter",VK_RETURN}
  };
  if (code.size() == 2 && code[0] == 'F' && code[1] >= '1' && code[1] <= '9') return static_cast<WORD>(VK_F1 + code[1] - '1');
  if (code.size() == 3 && code[0] == 'F' && code[1] == '1' && code[2] >= '0' && code[2] <= '2') return static_cast<WORD>(VK_F10 + code[2] - '0');
  if (code.rfind("Numpad", 0) == 0 && code.size() == 7 && code[6] >= '0' && code[6] <= '9') return static_cast<WORD>(VK_NUMPAD0 + code[6] - '0');
  auto it = keys.find(code); if (it == keys.end()) throw std::runtime_error("Unsupported key code"); return it->second;
}
static void handle(const json& value) {
  const auto type = value.value("type", std::string());
  if (type == "pointer.move") {
    const double x = value.at("x").get<double>(), y = value.at("y").get<double>(); if (x < 0 || x > 1 || y < 0 || y > 1) throw std::runtime_error("Invalid pointer position");
    INPUT input{}; input.type = INPUT_MOUSE; input.mi.dx = static_cast<LONG>(x * 65535.0); input.mi.dy = static_cast<LONG>(y * 65535.0); input.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE; inject(input);
  } else if (type == "pointer.button") {
    const auto name = value.at("button").get<std::string>(); const int index = name == "left" ? 0 : name == "middle" ? 1 : name == "right" ? 2 : -1; if (index < 0) throw std::runtime_error("Invalid pointer button"); button(index, value.at("down").get<bool>());
  } else if (type == "pointer.wheel") {
    const int dx = value.at("deltaX").get<int>(), dy = value.at("deltaY").get<int>(); if (abs(dx) > 1200 || abs(dy) > 1200) throw std::runtime_error("Invalid wheel delta");
    if (dy) { INPUT input{}; input.type = INPUT_MOUSE; input.mi.dwFlags = MOUSEEVENTF_WHEEL; input.mi.mouseData = static_cast<DWORD>(-dy); inject(input); }
    if (dx) { INPUT input{}; input.type = INPUT_MOUSE; input.mi.dwFlags = MOUSEEVENTF_HWHEEL; input.mi.mouseData = static_cast<DWORD>(dx); inject(input); }
  } else if (type == "key") key(virtual_key(value.at("code").get<std::string>()), value.at("down").get<bool>());
  else if (type == "release") release_all(); else throw std::runtime_error("Unsupported input event");
}
int main(int argc, char** argv) {
  dry_run = argc > 1 && std::string(argv[1]) == "--dry-run";
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  bool ready = false; std::string line;
  while (std::getline(std::cin, line)) {
    std::string request;
    try {
      if (line.size() > max_line) throw std::runtime_error("Packet too large"); const auto packet = json::parse(line); request = packet.at("requestId").get<std::string>();
      if (packet.value("protocolVersion", 0) != 1 || !packet.at("payload").is_object()) throw std::runtime_error("Invalid packet"); const auto type = packet.value("type", std::string());
      if (type == "input.hello") { ready = true; reply("input.ready", request, {{"dryRun", dry_run}}); }
      else if (!ready) throw std::runtime_error("Handshake required");
      else if (type == "input.event") { handle(packet.at("payload")); reply("input.applied", request); }
      else if (type == "input.shutdown") { release_all(); reply("input.stopped", request); return 0; }
      else throw std::runtime_error("Unsupported packet");
    } catch (const std::exception& error) { reply("input.error", request, {{"message", error.what()}}); }
  }
  release_all(); return 0;
}
