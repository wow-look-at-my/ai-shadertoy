# Build the headless GLES2 export demo.
#
# Needs an EGL + OpenGL ES 2.0 dev environment. On Debian/Ubuntu:
#   sudo apt-get install libegl1-mesa-dev libgles2-mesa-dev
# To run headless on a machine with no GPU, a software driver works:
#   sudo apt-get install libgl1-mesa-dri    # provides swrast/llvmpipe
#   LIBGL_ALWAYS_SOFTWARE=1 ./demo
CXX      ?= g++
CXXFLAGS ?= -O2 -std=c++11 -Wall -I.
LDLIBS   ?= -lEGL -lGLESv2

demo: demo.cpp shadertoy_gles2.h shadertoy_export.gen.h third_party/stb_image.h third_party/stb_image_write.h
	$(CXX) $(CXXFLAGS) demo.cpp -o demo $(LDLIBS)

run: demo
	./demo

clean:
	rm -f demo render_*.png

.PHONY: run clean
