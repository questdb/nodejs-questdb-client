cmake_minimum_required(VERSION 3.15.0)
project(questdbclient VERSION 0.0.18)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

include(FetchContent)
FetchContent_Declare(
        c-questdb-client
        GIT_REPOSITORY https://github.com/questdb/c-questdb-client.git
        GIT_TAG origin/main)
FetchContent_MakeAvailable(c-questdb-client)
include_directories(${CMAKE_JS_INC})

file(GLOB SOURCE_FILES "src/*.cc")
add_library(${PROJECT_NAME} SHARED ${SOURCE_FILES} ${CMAKE_JS_SRC})
target_include_directories(${PROJECT_NAME}  PRIVATE include/)
set_target_properties(${PROJECT_NAME} PROPERTIES PREFIX "" SUFFIX ".node")

target_link_libraries(${PROJECT_NAME} PRIVATE ${CMAKE_JS_LIB} questdb_client)
