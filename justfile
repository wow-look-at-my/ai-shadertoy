# The package's own binaries come first on PATH, as npm run puts them.
export PATH := justfile_directory() + "/node_modules/.bin:" + env_var("PATH")

[private]
help:
	@just --list

# The npm script typecheck.
typecheck:
	tsc --noEmit

# The npm script test.
test:
	node --experimental-strip-types --test test/*.test.ts

# The npm script build.
build:
	ts0 build

# The npm script check.
check:
	just typecheck && just test && just build
