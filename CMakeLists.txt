cmake_minimum_required(VERSION 3.24)

project(pocketjs_bench LANGUAGES C)

if(NOT CMAKE_CONFIGURATION_TYPES AND NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()

set(POCKET_SHELL_PROFILE "host" CACHE STRING "Shell profile: host, so3-arm32, or so3-aarch64")
set_property(CACHE POCKET_SHELL_PROFILE PROPERTY STRINGS host so3-arm32 so3-aarch64)
option(POCKET_BUILD_SHELL "Build the benchmark shell" ON)
option(POCKET_BUILD_PLUGIN "Build the QEMU pocketcount plugin" OFF)
option(POCKET_SKIP_CARGO "Use an already-built pocket-bench Rust archive" OFF)
set(POCKET_CARGO_TARGET_DIRECTORY "" CACHE PATH "Cargo target directory; defaults to crates/pocket-bench/target")
set(POCKET_SHELL_OUTPUT_DIRECTORY "" CACHE PATH "Shell output directory; defaults to dist/shell/<profile>")
set(POCKET_QEMU_VERSION "10.0.11" CACHE STRING "QEMU version whose plugin header is used")
set(POCKET_QEMU_PLUGIN_HEADER "" CACHE FILEPATH "Existing qemu-plugin.h; downloaded when empty")
set(POCKET_QEMU_PLUGIN_HEADER_SHA256 "" CACHE STRING "SHA-256 for a downloaded non-default qemu-plugin.h")
set(POCKET_PLUGIN_OUTPUT_DIRECTORY "${CMAKE_SOURCE_DIR}/dist/plugin" CACHE PATH "pocketcount output directory")

if(NOT CMAKE_C_COMPILER_ID MATCHES "GNU|Clang|AppleClang")
  message(FATAL_ERROR "PocketJS benchmark supports GCC and Clang compatible C compilers")
endif()

set(POCKET_ROOT "${CMAKE_CURRENT_SOURCE_DIR}")
set(POCKET_SHELL_DIR "${POCKET_ROOT}/shell")
set(POCKET_RUNTIME_DIR "${POCKET_ROOT}/vendor/pocketjs/engine/quickjs-c")
set(POCKET_UI_CABI_DIR "${POCKET_ROOT}/vendor/pocketjs/engine/ui-cabi")
set(POCKET_GENERATED_CONTRACT_DIR "${POCKET_ROOT}/vendor/pocketjs/contracts/generated")
set(POCKET_QUICKJS_DIR "${POCKET_ROOT}/vendor/quickjs-rs/libquickjs-sys/embed/quickjs")
set(POCKET_CRATE_DIR "${POCKET_ROOT}/crates/pocket-bench")

function(pocket_require_file path)
  if(NOT EXISTS "${path}")
    message(FATAL_ERROR "Required file is missing: ${path}. Initialize the git submodules first.")
  endif()
endfunction()

function(pocket_configure_shell_object target)
  target_include_directories(
    "${target}"
    PRIVATE
      "${POCKET_SHELL_DIR}"
      "${POCKET_RUNTIME_DIR}"
      "${POCKET_UI_CABI_DIR}/include"
      "${POCKET_GENERATED_CONTRACT_DIR}"
  )
  target_include_directories("${target}" SYSTEM PRIVATE "${POCKET_QUICKJS_DIR}")
  target_compile_options("${target}" PRIVATE -std=c99 -Wall -Wextra -fwrapv)
  target_compile_definitions(
    "${target}"
    PRIVATE
      POCKETJS_TARGET_ID="bench"
      POCKETJS_HOST_ABI=0
      POCKET_RUNTIME_STAGE_HOOKS
      POCKET_RUNTIME_HARNESS
      PB_QUICKJS_VERSION="${POCKET_QUICKJS_VERSION}"
  )
  if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
    target_compile_definitions("${target}" PRIVATE _POSIX_C_SOURCE=200809L)
  endif()
  if(POCKET_SHELL_PROFILE STREQUAL "so3-arm32")
    target_compile_definitions("${target}" PRIVATE PB_HOST_NAME="so3-virt32")
  elseif(POCKET_SHELL_PROFILE STREQUAL "so3-aarch64")
    target_compile_definitions("${target}" PRIVATE PB_HOST_NAME="so3-virt64")
  endif()
endfunction()

if(POCKET_BUILD_SHELL)
  if(NOT POCKET_SHELL_PROFILE MATCHES "^(host|so3-arm32|so3-aarch64)$")
    message(FATAL_ERROR "POCKET_SHELL_PROFILE must be host, so3-arm32, or so3-aarch64")
  endif()

  pocket_require_file("${POCKET_QUICKJS_DIR}/VERSION")
  pocket_require_file("${POCKET_RUNTIME_DIR}/pocket_runtime.c")
  pocket_require_file("${POCKET_CRATE_DIR}/Cargo.toml")
  file(STRINGS "${POCKET_QUICKJS_DIR}/VERSION" POCKET_QUICKJS_VERSION LIMIT_COUNT 1)
  string(STRIP "${POCKET_QUICKJS_VERSION}" POCKET_QUICKJS_VERSION)
  if(NOT POCKET_CARGO_TARGET_DIRECTORY)
    set(POCKET_CARGO_TARGET_DIRECTORY "${POCKET_CRATE_DIR}/target")
  endif()

  if(POCKET_SHELL_PROFILE STREQUAL "host")
    set(_pocket_default_shell_output "${POCKET_ROOT}/dist/shell/host")
    set(POCKET_CARGO_TARGET "")
    set(POCKET_RUST_ARCHIVE "${POCKET_CARGO_TARGET_DIRECTORY}/release/libpocket_bench.a")
    set(POCKET_MARKS_SOURCE "${POCKET_SHELL_DIR}/marks_host.c")
  elseif(POCKET_SHELL_PROFILE STREQUAL "so3-arm32")
    set(_pocket_default_shell_output "${POCKET_ROOT}/dist/shell/so3-arm32")
    set(POCKET_CARGO_TARGET "armv7-unknown-linux-musleabihf")
    set(POCKET_RUST_ARCHIVE "${POCKET_CARGO_TARGET_DIRECTORY}/${POCKET_CARGO_TARGET}/release/libpocket_bench.a")
    set(POCKET_MARKS_SOURCE "${POCKET_SHELL_DIR}/marks_so3.c")
  else()
    set(_pocket_default_shell_output "${POCKET_ROOT}/dist/shell/so3-aarch64")
    set(POCKET_CARGO_TARGET "aarch64-unknown-linux-musl")
    set(POCKET_RUST_ARCHIVE "${POCKET_CARGO_TARGET_DIRECTORY}/${POCKET_CARGO_TARGET}/release/libpocket_bench.a")
    set(POCKET_MARKS_SOURCE "${POCKET_SHELL_DIR}/marks_so3.c")
  endif()
  if(NOT POCKET_SHELL_OUTPUT_DIRECTORY)
    set(POCKET_SHELL_OUTPUT_DIRECTORY "${_pocket_default_shell_output}")
  endif()

  if(POCKET_SKIP_CARGO)
    if(NOT EXISTS "${POCKET_RUST_ARCHIVE}")
      message(FATAL_ERROR "POCKET_SKIP_CARGO is ON but ${POCKET_RUST_ARCHIVE} does not exist")
    endif()
    add_custom_target(pocket-bench-rust)
  else()
    find_program(POCKET_CARGO_EXECUTABLE cargo REQUIRED)
    set(POCKET_CARGO_ARGS build --release)
    if(POCKET_CARGO_TARGET)
      list(APPEND POCKET_CARGO_ARGS --target "${POCKET_CARGO_TARGET}")
    endif()
    add_custom_target(
      pocket-bench-rust
      COMMAND
        "${CMAKE_COMMAND}" -E env "CARGO_TARGET_DIR=${POCKET_CARGO_TARGET_DIRECTORY}"
        "${POCKET_CARGO_EXECUTABLE}" ${POCKET_CARGO_ARGS}
      WORKING_DIRECTORY "${POCKET_CRATE_DIR}"
      BYPRODUCTS "${POCKET_RUST_ARCHIVE}"
      USES_TERMINAL
      VERBATIM
    )
  endif()

  add_library(
    pocket-quickjs OBJECT
    "${POCKET_QUICKJS_DIR}/cutils.c"
    "${POCKET_QUICKJS_DIR}/dtoa.c"
    "${POCKET_QUICKJS_DIR}/libregexp.c"
    "${POCKET_QUICKJS_DIR}/libunicode.c"
    "${POCKET_QUICKJS_DIR}/quickjs.c"
  )
  target_include_directories(pocket-quickjs PRIVATE "${POCKET_QUICKJS_DIR}")
  target_compile_options(pocket-quickjs PRIVATE -std=gnu11 -funsigned-char -fno-strict-aliasing -w)
  target_compile_definitions(pocket-quickjs PRIVATE _GNU_SOURCE CONFIG_VERSION="${POCKET_QUICKJS_VERSION}")

  add_library(
    pocket-shell-common OBJECT
    "${POCKET_SHELL_DIR}/arena.c"
    "${POCKET_SHELL_DIR}/vtime.c"
    "${POCKET_MARKS_SOURCE}"
    "${POCKET_SHELL_DIR}/jsglue.c"
    "${POCKET_RUNTIME_DIR}/rust_eh_personality.c"
  )
  pocket_configure_shell_object(pocket-shell-common)

  function(pocket_add_main_object target)
    add_library("${target}" OBJECT "${POCKET_SHELL_DIR}/main.c")
    pocket_configure_shell_object("${target}")
  endfunction()

  function(pocket_add_runtime_object target)
    add_library("${target}" OBJECT "${POCKET_RUNTIME_DIR}/pocket_runtime.c")
    pocket_configure_shell_object("${target}")
    target_compile_options("${target}" PRIVATE "-include${POCKET_SHELL_DIR}/runtime_overrides.h")
  endfunction()

  function(pocket_add_shell_executable target output_name)
    add_executable("${target}" ${ARGN})
    set_target_properties(
      "${target}"
      PROPERTIES
        OUTPUT_NAME "${output_name}"
        RUNTIME_OUTPUT_DIRECTORY "${POCKET_SHELL_OUTPUT_DIRECTORY}"
        LINKER_LANGUAGE C
    )
    add_dependencies("${target}" pocket-bench-rust)
    set_property(TARGET "${target}" APPEND PROPERTY LINK_DEPENDS "${POCKET_RUST_ARCHIVE}")
    target_link_libraries("${target}" PRIVATE "${POCKET_RUST_ARCHIVE}" m)
  endfunction()

  pocket_add_main_object(pocket-main-measure)
  pocket_add_runtime_object(pocket-runtime-measure)

  if(POCKET_SHELL_PROFILE STREQUAL "host")
    pocket_add_main_object(pocket-main-observe)
    target_compile_definitions(pocket-main-observe PRIVATE PB_OBSERVE)
    pocket_add_runtime_object(pocket-runtime-observe)
    target_compile_definitions(pocket-runtime-observe PRIVATE PB_OBSERVE)
    target_compile_options(pocket-runtime-observe PRIVATE "-include${POCKET_SHELL_DIR}/generated/record_ops.h")

    add_library(
      pocket-record-observe OBJECT
      "${POCKET_SHELL_DIR}/record.c"
      "${POCKET_SHELL_DIR}/generated/record_ops.c"
    )
    pocket_configure_shell_object(pocket-record-observe)
    target_compile_definitions(pocket-record-observe PRIVATE PB_OBSERVE)

    pocket_add_main_object(pocket-main-guest)
    target_compile_definitions(pocket-main-guest PRIVATE PB_GUEST_TAPE)
    # main.c also contains the non-guest drivers; the guest entry deliberately
    # compiles them out at dispatch time.
    target_compile_options(pocket-main-guest PRIVATE -Wno-unused-function)
    pocket_add_runtime_object(pocket-runtime-guest)
    target_compile_definitions(pocket-runtime-guest PRIVATE PB_GUEST_TAPE)
    target_compile_options(pocket-runtime-guest PRIVATE "-include${POCKET_SHELL_DIR}/generated/tape_ops.h")

    add_library(
      pocket-tape-guest OBJECT
      "${POCKET_SHELL_DIR}/tape_host.c"
      "${POCKET_SHELL_DIR}/generated/tape_ops.c"
    )
    pocket_configure_shell_object(pocket-tape-guest)
    target_compile_definitions(pocket-tape-guest PRIVATE PB_GUEST_TAPE)

    pocket_add_shell_executable(
      pocket-bench-shell
      pocket-bench-shell
      $<TARGET_OBJECTS:pocket-quickjs>
      $<TARGET_OBJECTS:pocket-shell-common>
      $<TARGET_OBJECTS:pocket-main-measure>
      $<TARGET_OBJECTS:pocket-runtime-measure>
    )
    pocket_add_shell_executable(
      pocket-bench-shell-observe
      pocket-bench-shell-observe
      $<TARGET_OBJECTS:pocket-quickjs>
      $<TARGET_OBJECTS:pocket-shell-common>
      $<TARGET_OBJECTS:pocket-main-observe>
      $<TARGET_OBJECTS:pocket-runtime-observe>
      $<TARGET_OBJECTS:pocket-record-observe>
    )
    pocket_add_shell_executable(
      pocket-bench-shell-guest
      pocket-bench-shell-guest
      $<TARGET_OBJECTS:pocket-quickjs>
      $<TARGET_OBJECTS:pocket-shell-common>
      $<TARGET_OBJECTS:pocket-main-guest>
      $<TARGET_OBJECTS:pocket-runtime-guest>
      $<TARGET_OBJECTS:pocket-tape-guest>
    )
    add_custom_target(
      shell-host
      DEPENDS pocket-bench-shell pocket-bench-shell-observe pocket-bench-shell-guest
    )
  else()
    pocket_add_shell_executable(
      pocket-bench-shell
      pocket-bench-shell
      $<TARGET_OBJECTS:pocket-quickjs>
      $<TARGET_OBJECTS:pocket-shell-common>
      $<TARGET_OBJECTS:pocket-main-measure>
      $<TARGET_OBJECTS:pocket-runtime-measure>
    )
    target_link_options(
      pocket-bench-shell
      PRIVATE
        -static
        "LINKER:-Map=${POCKET_SHELL_OUTPUT_DIRECTORY}/shell.map"
    )
  endif()
endif()

if(POCKET_BUILD_PLUGIN)
  find_package(PkgConfig REQUIRED)
  pkg_check_modules(POCKET_GLIB REQUIRED IMPORTED_TARGET glib-2.0)

  if(POCKET_QEMU_PLUGIN_HEADER)
    get_filename_component(
      POCKET_QEMU_PLUGIN_HEADER
      "${POCKET_QEMU_PLUGIN_HEADER}"
      ABSOLUTE
      BASE_DIR "${CMAKE_CURRENT_SOURCE_DIR}"
    )
    pocket_require_file("${POCKET_QEMU_PLUGIN_HEADER}")
  else()
    set(POCKET_QEMU_PLUGIN_HEADER "${CMAKE_BINARY_DIR}/qemu-plugin.h")
    set(_pocket_header_hash "${POCKET_QEMU_PLUGIN_HEADER_SHA256}")
    if(NOT _pocket_header_hash AND POCKET_QEMU_VERSION STREQUAL "10.0.11")
      set(_pocket_header_hash "ceca12f3ba448340b38223617b1c66d7b92e0e0d78687d1e108c42287542836e")
    endif()
    if(NOT _pocket_header_hash)
      message(FATAL_ERROR "Set POCKET_QEMU_PLUGIN_HEADER_SHA256 when downloading a non-default QEMU header")
    endif()
    file(
      DOWNLOAD
      "https://gitlab.com/qemu-project/qemu/-/raw/v${POCKET_QEMU_VERSION}/include/qemu/qemu-plugin.h"
      "${POCKET_QEMU_PLUGIN_HEADER}"
      EXPECTED_HASH "SHA256=${_pocket_header_hash}"
      TLS_VERIFY ON
      STATUS _pocket_download_status
    )
    list(GET _pocket_download_status 0 _pocket_download_code)
    if(NOT _pocket_download_code EQUAL 0)
      list(GET _pocket_download_status 1 _pocket_download_message)
      message(FATAL_ERROR "Could not download qemu-plugin.h: ${_pocket_download_message}")
    endif()
  endif()

  get_filename_component(POCKET_QEMU_PLUGIN_INCLUDE_DIR "${POCKET_QEMU_PLUGIN_HEADER}" DIRECTORY)
  add_library(pocketcount-object OBJECT "${POCKET_ROOT}/plugin/pocketcount.c")
  set_target_properties(pocketcount-object PROPERTIES POSITION_INDEPENDENT_CODE ON)
  target_compile_options(pocketcount-object PRIVATE -std=gnu11 -O2 -Wall -Wextra)
  target_include_directories(pocketcount-object PRIVATE "${POCKET_QEMU_PLUGIN_INCLUDE_DIR}")
  target_link_libraries(pocketcount-object PRIVATE PkgConfig::POCKET_GLIB)

  add_library(pocketcount MODULE $<TARGET_OBJECTS:pocketcount-object>)
  set_target_properties(
    pocketcount
    PROPERTIES
      PREFIX "lib"
      SUFFIX ".so"
      LIBRARY_OUTPUT_DIRECTORY "${POCKET_PLUGIN_OUTPUT_DIRECTORY}"
  )
  target_link_libraries(pocketcount PRIVATE PkgConfig::POCKET_GLIB)
  if(APPLE)
    target_link_options(pocketcount PRIVATE "LINKER:-undefined,dynamic_lookup")
  endif()
  add_custom_target(pocketcount-check DEPENDS pocketcount-object)
endif()
