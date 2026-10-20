# An extracted, modified WebRTC implementation, NOT an official WebRTC release.
# Keep isolated until provenance, timing and device recovery are qualified.
enable_language(C)
if(NOT MSVC OR NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
  message(FATAL_ERROR "AEC3 evaluation currently supports MSVC x64 only")
endif()
FetchContent_Declare(aec3_source
  URL https://codeload.github.com/Enaium/webrtc-aec3/tar.gz/2cec2f52e26646f93bd2d5498bbabf59cba18da9
  URL_HASH SHA256=3bc3423e71b7280cf96d87b2e429444ed3fee364b94648ce9875ee95b8f485f8
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE TIMEOUT 120 INACTIVITY_TIMEOUT 30
  SOURCE_SUBDIR darling-unused)
FetchContent_MakeAvailable(aec3_source)
set(aec_root "${aec3_source_SOURCE_DIR}/src")
file(GLOB_RECURSE aec_sources CONFIGURE_DEPENDS "${aec_root}/*.cc" "${aec_root}/*.c" "${aec_root}/*.cpp")
list(FILTER aec_sources EXCLUDE REGEX "(_neon\\.cc|cpu_features_android\\.c|cpu_features_linux\\.c)$")
# MSVC vector types expose named lanes, unlike Clang's vector subscripting.
# Patch a build-tree copy only; keep the pinned download untouched.
set(matched_filter "${aec_root}/audio_processing/aec3/matched_filter_avx2.cc")
file(READ "${matched_filter}" matched_text)
string(REPLACE "s_inst_hadd_256[" "s_inst_hadd_256.m256_f32[" matched_text "${matched_text}")
string(REPLACE "e_128[" "e_128.m128_f32[" matched_text "${matched_text}")
string(REPLACE "sum[" "sum.m128_f32[" matched_text "${matched_text}")
set(matched_copy "${CMAKE_CURRENT_BINARY_DIR}/matched_filter_avx2_msvc.cc")
file(CONFIGURE OUTPUT "${matched_copy}" CONTENT "${matched_text}" @ONLY)
list(REMOVE_ITEM aec_sources "${matched_filter}")
list(APPEND aec_sources "${matched_copy}")
# Instrument a build-tree copy. Pinned source is unchanged. Normal profiles never collect.
set(echo_source "${aec_root}/audio_processing/aec3/echo_remover.cc")
file(READ "${echo_source}" echo_text)
set(trace_anchor "    suppression_filter_.ApplyGain(comfort_noise, high_band_comfort_noise, G,")
string(FIND "${echo_text}" "${trace_anchor}" trace_index)
if(trace_index EQUAL -1)
  message(FATAL_ERROR "AEC3 diagnostic insertion point changed")
endif()
set(trace_code [=[
    if (darling_aec_trace::enabled) {
      auto& t = darling_aec_trace::stats;
      ++t.blocks;
      t.usable += aec_state_.UsableLinearEstimate();
      t.dominant += suppression_gain_.IsDominantNearend();
      t.saturated += aec_state_.SaturatedEcho();
      const auto delay = aec_state_.ExternalDelayBlocks();
      if (delay) {
        ++t.delayKnown;
        t.delayRefined += delay->quality == webrtc::DelayEstimate::Quality::kRefined;
        t.delaySum += delay->delay;
        if (delay->delay < t.delayMin) t.delayMin = delay->delay;
        if (delay->delay > t.delayMax) t.delayMax = delay->delay;
      }
      t.filterDelayLast = aec_state_.MinDirectPathFilterDelay();
      t.filterLengthLast = aec_state_.FilterLengthBlocks();
      for (size_t k = 1; k < 64; ++k) {
        t.nearPower += nearend_spectrum[0][k];
        t.residualPower += R2[0][k];
        t.amplitudeGain += G[k] / 63.0;
      }
    }
]=])
string(REPLACE "${trace_anchor}" "${trace_code}\n${trace_anchor}" echo_text "${echo_text}")
set(echo_copy "${CMAKE_CURRENT_BINARY_DIR}/echo_remover_traced.cc")
file(CONFIGURE OUTPUT "${echo_copy}" CONTENT "#include \"aec3_trace.h\"\n${echo_text}" @ONLY)
list(REMOVE_ITEM aec_sources "${echo_source}")
list(APPEND aec_sources "${echo_copy}")
# Observe actual matched-filter branch decisions without changing conditions.
set(match_source "${aec_root}/audio_processing/aec3/matched_filter.cc")
file(READ "${match_source}" match_text)
set(match_anchor "    if (x2_sum > x2_sum_threshold && !saturation) {")
set(reliable_anchor "    // Find the best estimate")
set(winner_anchor "  if (winner_index != -1) {")
foreach(anchor IN ITEMS "${match_anchor}" "${reliable_anchor}" "${winner_anchor}")
  string(FIND "${match_text}" "${anchor}" match_index)
  if(match_index EQUAL -1)
    message(FATAL_ERROR "Matched-filter diagnostic insertion point changed")
  endif()
endforeach()
set(match_code [=[
    if (darling_aec_trace::enabled) {
      auto& t = darling_aec_trace::stats;
      ++t.matchSamples;
      t.lowEnergy += !(x2_sum > x2_sum_threshold);
      t.matchSaturated += saturation;
      t.eligible += x2_sum > x2_sum_threshold && !saturation;
    }
]=])
set(reliable_code [=[
    if (darling_aec_trace::enabled) {
      auto& t = darling_aec_trace::stats;
      ++t.filtersChecked;
      t.filtersUpdated += filters_updated;
      t.reliableUpdated += filters_updated && reliable;
    }
]=])
string(REPLACE "${match_anchor}" "${match_code}\n${match_anchor}" match_text "${match_text}")
string(REPLACE "${reliable_anchor}" "${reliable_code}\n${reliable_anchor}" match_text "${match_text}")
string(REPLACE "${winner_anchor}" "  if (darling_aec_trace::enabled && winner_index != -1) ++darling_aec_trace::stats.winners;\n${winner_anchor}" match_text "${match_text}")
set(match_copy "${CMAKE_CURRENT_BINARY_DIR}/matched_filter_traced.cc")
file(CONFIGURE OUTPUT "${match_copy}" CONTENT "#include \"aec3_trace.h\"\n${match_text}" @ONLY)
list(REMOVE_ITEM aec_sources "${match_source}")
list(APPEND aec_sources "${match_copy}")
add_library(darling-aec3-experimental STATIC ${aec_sources})
target_include_directories(darling-aec3-experimental PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/src")
target_compile_features(darling-aec3-experimental PUBLIC cxx_std_20)
target_compile_definitions(darling-aec3-experimental PUBLIC WEBRTC_WIN NOMINMAX WIN32_LEAN_AND_MEAN PRIVATE _USE_MATH_DEFINES)
target_include_directories(darling-aec3-experimental SYSTEM PUBLIC
  "${aec_root}" "${aec_root}/api" "${aec_root}/base" "${aec_root}/base/rtc_base"
  "${aec_root}/base/system_wrappers/include" "${aec_root}/audio_processing"
  "${aec_root}/absl" "${aec_root}/base/jsoncpp/include" "${aec_root}/audio_processing/aec3"
  "${aec_root}/audio_processing/resampler" "${aec_root}/audio_processing/logging"
  "${aec_root}/audio_processing/include" "${aec_root}/audio_processing/utility"
  "${aec_root}/rtc_base/experiments" "${aec_root}/common_audio"
  "${aec_root}/common_audio/third_party/ooura/fft_size_128")
target_compile_options(darling-aec3-experimental PRIVATE /EHsc /utf-8 /MP4)
set_source_files_properties("${aec_root}/audio_processing/audio_buffer.cc" PROPERTIES COMPILE_OPTIONS /FIarray)
target_link_libraries(darling-aec3-experimental PUBLIC winmm)
add_executable(aec3-evaluation tests/aec3_evaluation.cpp tests/aec3_scenarios.cpp tests/aec3_negative.cpp src/aec3_processor.cpp)
target_include_directories(aec3-evaluation PRIVATE src)
target_link_libraries(aec3-evaluation PRIVATE darling-aec3-experimental)
add_custom_command(TARGET aec3-evaluation POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_if_different "${aec3_source_SOURCE_DIR}/LICENSE"
    "$<TARGET_FILE_DIR:aec3-evaluation>/webrtc-aec3-LICENSE")
add_test(NAME aec3-evaluation COMMAND aec3-evaluation)
set_tests_properties(aec3-evaluation PROPERTIES TIMEOUT 60)

# Opt-in executable, never installed over the default desktop engine.
add_executable(darling-media-aec3 src/main.cpp src/devices.cpp src/capture.cpp src/playback.cpp src/aec3_processor.cpp)
target_compile_definitions(darling-media-aec3 PRIVATE DARLING_REALTIME_AEC3 UNICODE _UNICODE)
target_compile_options(darling-media-aec3 PRIVATE /W4 /EHsc /utf-8)
target_link_libraries(darling-media-aec3 PRIVATE darling-aec3-experimental nlohmann_json::nlohmann_json ole32 propsys uuid avrt)
add_custom_command(TARGET darling-media-aec3 POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_if_different "${aec3_source_SOURCE_DIR}/LICENSE"
    "$<TARGET_FILE_DIR:darling-media-aec3>/webrtc-aec3-LICENSE"
  COMMAND ${CMAKE_COMMAND} -E copy_if_different "${json_SOURCE_DIR}/LICENSE.MIT"
    "$<TARGET_FILE_DIR:darling-media-aec3>/nlohmann-json-LICENSE.MIT")
