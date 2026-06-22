#!/usr/bin/env bash
#
# extract.sh -- regenerate the GLES2 (GLSL ES 1.00) shader export from a raw
# ai-shadertoy project export JSON, using jq to traverse the dump.
#
# Usage:
#   ./extract.sh [path-to-export.json]
#
# Default input is ./source-export.json (committed alongside this script).
# Output is written in place next to this script: one folder per project plus
# common/ , assets/ and per-project manifest.json files. Re-running is
# idempotent: generated project/asset/common dirs are wiped and rebuilt.
#
# The export app wraps a Shadertoy-style `mainImage` in a GLSL ES 3.00
# (#version 300 es) program. This script reproduces that wrapper for OpenGL
# ES 2.0 / GLSL ES 1.00 instead:
#   * #version 100 + a highp/mediump precision guard (no sampler precision)
#   * texture(...)        -> texture2D(...)
#   * out vec4 / mainImage -> gl_FragColor written from a generated main()
#   * inline `uniform ...;` decls in the body are stripped and re-declared
#     once in the header (mirrors the app's stripUniformDeclarations), so a
#     pass body that declares its own uniforms still compiles.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
f="${1:-$here/source-export.json}"

if ! command -v jq >/dev/null 2>&1; then echo "jq is required" >&2; exit 1; fi
if [ ! -f "$f" ]; then echo "input not found: $f" >&2; exit 1; fi

echo "input: $f"

# --- slugify a project/pass name into a filesystem-safe token ----------------
slug() { echo "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/_/g; s/^_+//; s/_+$//'; }

# --- map a uniform type to its GLSL type (color is a vec3) -------------------
# (kept in sync with glslType() in src/gl/wrapper.ts)

# --- transform a Shadertoy mainImage body for GLSL ES 1.00 -------------------
# 1. strip inline custom-uniform declarations (the header re-adds them), using
#    the same shape as CUSTOM_UNIFORM_RE in src/gl/wrapper.ts.
# 2. texture( -> texture2D(   (the only sampler call these shaders use)
gles2_body() {
	perl -0777 -pe '
		s/^[ \t]*uniform[ \t]+(?:(?:lowp|mediump|highp)[ \t]+)?(?:float|vec2|vec3|vec4)[ \t]+[A-Za-z_][A-Za-z0-9_]*[ \t]*(?:=[ \t]*[^;\n]*?)?[ \t]*;[ \t]*\n?//mg;
		s/\btexture(\s*)\(/texture2D$1(/g;
	'
}

# canonical Shadertoy built-in declarations (emitted only when referenced).
builtin_decl() {
	case "$1" in
		iResolution) echo 'uniform vec3  iResolution;        // viewport resolution in px (z = pixel aspect, use 1.0)';;
		iTime)       echo 'uniform float iTime;              // playback time in seconds';;
		iTimeDelta)  echo 'uniform float iTimeDelta;         // seconds since the previous frame';;
		iFrameRate)  echo 'uniform float iFrameRate;         // frames per second';;
		iFrame)      echo 'uniform int   iFrame;             // playback frame index';;
		iMouse)      echo 'uniform vec4  iMouse;             // xy = current px (while pressed), zw = last click px';;
		iDate)       echo 'uniform vec4  iDate;              // (year, month, day, seconds-in-day)';;
	esac
}

# strip GLSL comments so identifier-usage probes don't fire on prose.
strip_comments() { perl -0777 -pe 's{//[^\n]*}{}g; s{/\*.*?\*/}{}gs'; }

# --- assemble one complete GLSL ES 1.00 fragment shader for a pass -----------
# Only the built-ins, channels and custom uniforms the body actually references
# are declared, so nothing ships unused. args: project-index pass-index out-file
emit_frag() {
	local p="$1" q="$2" out="$3"
	local pname projname chans fmt body probe
	pname=$(jq -r --argjson p "$p" --argjson q "$q" '.projects[$p].layers[0].passes[$q].name' "$f")
	projname=$(jq -r --argjson p "$p" '.projects[$p].name' "$f")
	chans=$(jq -r --argjson p "$p" --argjson q "$q" '.projects[$p].layers[0].passes[$q].channels | length' "$f")
	fmt=$(jq -r --argjson p "$p" --argjson q "$q" '.projects[$p].layers[0].passes[$q].format' "$f")
	body=$(jq -r --argjson p "$p" --argjson q "$q" '.projects[$p].layers[0].passes[$q].source' "$f" | gles2_body)
	probe=$(printf '%s' "$body" | strip_comments)
	uses() { grep -qw -- "$1" <<<"$probe"; }

	# built-ins referenced (canonical order)
	local b; local -a used_builtins=()
	for b in iResolution iTime iTimeDelta iFrameRate iFrame iMouse iDate; do
		uses "$b" && used_builtins+=("$b")
	done

	# iChannelResolution[] -- only if used, sized to highest literal index + 1
	local resN=0 maxidx
	if uses iChannelResolution; then
		maxidx=$(grep -oE 'iChannelResolution\[[0-9]+\]' <<<"$probe" | grep -oE '[0-9]+' | sort -n | tail -1)
		if [ -n "$maxidx" ]; then resN=$((maxidx + 1)); else resN=$chans; fi
	fi

	# iChannelN samplers referenced
	local i; local -a used_channels=()
	for ((i = 0; i < chans; i++)); do uses "iChannel$i" && used_channels+=("$i"); done

	# custom uniforms referenced
	local uname; local -a used_uniforms=()
	while IFS= read -r uname; do
		[ -n "$uname" ] && uses "$uname" && used_uniforms+=("$uname")
	done < <(jq -r --argjson p "$p" '.projects[$p].uniforms[].name' "$f")

	{
		echo "// ============================================================================"
		echo "// $projname  ::  pass \"$pname\"   (render target format: $fmt)"
		echo "// Exported from ai-shadertoy and ported to GLSL ES 1.00 (OpenGL ES 2.0)."
		echo "// Pair with common/fullscreen.vert. Only the uniforms and channels this pass"
		echo "// actually references are declared; see manifest.json for the wiring/defaults."
		echo "// ============================================================================"
		echo "#version 100"
		echo "#ifdef GL_FRAGMENT_PRECISION_HIGH"
		echo "precision highp float;"
		echo "precision highp int;"
		echo "#else"
		echo "precision mediump float;"
		echo "precision mediump int;"
		echo "#endif"
		if [ "${#used_builtins[@]}" -gt 0 ]; then
			echo ""
			echo "// --- Shadertoy built-in uniforms used by this pass ---"
			for b in "${used_builtins[@]}"; do builtin_decl "$b"; done
		fi
		if [ "${#used_channels[@]}" -gt 0 ] || [ "$resN" -gt 0 ]; then
			echo ""
			echo "// --- Input channels used by this pass (see manifest.json for bindings) ---"
			for i in "${used_channels[@]}"; do echo "uniform sampler2D iChannel${i};"; done
			[ "$resN" -gt 0 ] && echo "uniform vec3 iChannelResolution[${resN}];   // px size of each iChannel"
		fi
		if [ "${#used_uniforms[@]}" -gt 0 ]; then
			echo ""
			echo "// --- Custom uniforms used by this pass (project defaults in manifest.json) ---"
			for uname in "${used_uniforms[@]}"; do
				jq -r --argjson p "$p" --arg n "$uname" '
					.projects[$p].uniforms[] | select(.name==$n)
					| "uniform \(if .type=="color" then "vec3" else .type end) \(.name);"
				' "$f"
			done
		fi
		echo ""
		echo "// ============================ user shader body ============================"
		printf '%s\n' "$body"
		echo "// ============================ generated entry point ============================"
		echo "void main() {"
		echo "	vec4 ai_color = vec4(0.0, 0.0, 0.0, 1.0);"
		echo "	mainImage(ai_color, gl_FragCoord.xy);"
		echo "	gl_FragColor = ai_color;"
		echo "}"
	} > "$out"
}

# --- topological render order (Kahn) for a project's pass DAG -----------------
# Channels of kind "pass" are intra-layer edges (consumer depends on producer).
# Prints pass ids in a valid render order, stable to input order.
render_order_ids() {
	local p="$1"
	local -a ids
	mapfile -t ids < <(jq -r --argjson p "$p" '.projects[$p].layers[0].passes[].id' "$f")
	declare -A deps
	local id
	for id in "${ids[@]}"; do
		deps[$id]=$(jq -r --argjson p "$p" --arg id "$id" '
			.projects[$p].layers[0].passes[] | select(.id==$id)
			| [.channels[]? | select(.kind=="pass") | .passId] | join(" ")
		' "$f")
	done
	local -a emitted=()
	local progress=1 d ok
	while [ "${#emitted[@]}" -lt "${#ids[@]}" ] && [ "$progress" -eq 1 ]; do
		progress=0
		for id in "${ids[@]}"; do
			case " ${emitted[*]} " in *" $id "*) continue;; esac
			ok=1
			for d in ${deps[$id]:-}; do
				case " ${emitted[*]} " in *" $d "*) ;; *) ok=0;; esac
			done
			if [ "$ok" -eq 1 ]; then emitted+=("$id"); progress=1; fi
		done
	done
	if [ "${#emitted[@]}" -ne "${#ids[@]}" ]; then
		echo "WARNING: pass graph for project $p has a cycle; falling back to input order" >&2
		printf '%s\n' "${ids[@]}"; return
	fi
	printf '%s\n' "${emitted[@]}"
}

# --- per-project manifest.json -----------------------------------------------
# Describes the pass graph (with file names + resolved channel bindings),
# render order, output pass and the custom uniforms with their default values.
emit_manifest() {
	local p="$1" dir="$2"
	local -a order
	mapfile -t order < <(render_order_ids "$p")
	local order_json
	order_json=$(printf '%s\n' "${order[@]}" | jq -R . | jq -s .)

	# slug map (passId -> file base) so channel bindings can point at files
	local slugmap='{}'
	local q n pid base
	n=$(jq -r --argjson p "$p" '.projects[$p].layers[0].passes | length' "$f")
	for ((q=0;q<n;q++)); do
		pid=$(jq -r --argjson p "$p" --argjson q "$q" '.projects[$p].layers[0].passes[$q].id' "$f")
		base=$(slug "$(jq -r --argjson p "$p" --argjson q "$q" '.projects[$p].layers[0].passes[$q].name' "$f")")
		slugmap=$(jq --arg id "$pid" --arg b "$base" '. + {($id): $b}' <<<"$slugmap")
	done

	jq -n \
		--argjson p "$p" \
		--slurpfile root "$f" \
		--argjson order "$order_json" \
		--argjson slugmap "$slugmap" '
		# strip GLSL comments + inline uniform decls so usage probes match the
		# emitted shaders exactly (same shape as src/gl/wrapper.ts CUSTOM_UNIFORM_RE).
		def strip:
			gsub("//[^\n]*";"")
			| gsub("/\\*[\\s\\S]*?\\*/";"")
			| gsub("(?m)^[ \\t]*uniform[ \\t]+(?:(?:lowp|mediump|highp)[ \\t]+)?(?:float|vec2|vec3|vec4)[ \\t]+[A-Za-z_][A-Za-z0-9_]*[ \\t]*(?:=[ \\t]*[^;\\n]*?)?[ \\t]*;[ \\t]*$";"");
		($root[0]) as $r
		| ($r.projects[$p]) as $proj
		| ($proj.layers[0]) as $layer
		| ($r.assets | map({(.id): {name, mediaType, width, height, kind: (.kind // "image"), file: ("../assets/" + .id + (if (.mediaType|test("png")) then ".png" elif (.mediaType|test("jpeg")) then ".jpg" elif (.mediaType|test("mp4")) then ".mp4" elif (.mediaType|test("webm")) then ".webm" else ".bin" end))}}) | add) as $assets
		| ($layer.passes | map({(.id): .name}) | add) as $passNames
		| {
			project: $proj.name,
			projectId: $proj.id,
			note: "GLSL ES 1.00 / OpenGL ES 2.0 export. Render the passes in renderOrder each frame, each into its own framebuffer-sized RGBA8 texture, then present the outputPass texture. Each pass lists ONLY the channels/uniforms it samples. wrap values are the originals; on plain GLES2 use CLAMP_TO_EDGE for these NPOT textures (see README).",
			outputPass: $passNames[$layer.outputPassId],
			outputPassFile: ($slugmap[$layer.outputPassId] + ".frag"),
			renderOrder: [ $order[] | $passNames[.] ],
			customUniforms: $proj.uniforms,
			passes: [
				$layer.passes[]
				| (.source | strip) as $src
				| {
					name: .name,
					file: ($slugmap[.id] + ".frag"),
					format: .format,
					usesUniforms: [ $proj.uniforms[].name as $n | select($src | test("\\b" + $n + "\\b")) | $n ],
					channels: [
						.channels | to_entries[]
						| .key as $i | .value as $c
						| select($src | test("\\biChannel" + ($i|tostring) + "\\b"))
						| {
							channel: ("iChannel" + ($i|tostring)),
							kind: $c.kind,
							filter: $c.filter,
							wrap: $c.wrap
						}
						+ (if $c.kind=="pass" then {fromPass: $passNames[$c.passId], fromPassFile: ($slugmap[$c.passId] + ".frag")}
						   elif ($c.kind=="image" or $c.kind=="video") then {asset: $c.assetId, assetName: $assets[$c.assetId].name, assetFile: $assets[$c.assetId].file, assetSize: [$assets[$c.assetId].width, $assets[$c.assetId].height]}
						   else {} end)
					]
				}
			]
		}
	' > "$dir/manifest.json"
}

# --- decode the shared media assets ------------------------------------------
emit_assets() {
	local adir="$here/assets"
	rm -rf "$adir"; mkdir -p "$adir"
	local n i id mt ext
	n=$(jq -r '.assets | length' "$f")
	for ((i=0;i<n;i++)); do
		id=$(jq -r --argjson i "$i" '.assets[$i].id' "$f")
		mt=$(jq -r --argjson i "$i" '.assets[$i].mediaType' "$f")
		case "$mt" in
			*png) ext=png;; *jpeg) ext=jpg;; *mp4) ext=mp4;; *webm) ext=webm;; *) ext=bin;;
		esac
		jq -r --argjson i "$i" '.assets[$i].dataUrl | sub("^data:[^,]+,";"")' "$f" | base64 -d > "$adir/$id.$ext"
		echo "  asset $id.$ext"
	done
	# assets.json describes the media library
	jq '[.assets[] | {
		id, name, mediaType,
		kind: (.kind // "image"),
		width, height,
		source,
		file: (.id + (if (.mediaType|test("png")) then ".png" elif (.mediaType|test("jpeg")) then ".jpg" elif (.mediaType|test("mp4")) then ".mp4" elif (.mediaType|test("webm")) then ".webm" else ".bin" end))
	}]' "$f" > "$adir/assets.json"
}

# --- the shared GLES2 fullscreen vertex shader -------------------------------
emit_common() {
	local cdir="$here/common"
	rm -rf "$cdir"; mkdir -p "$cdir"
	cat > "$cdir/fullscreen.vert" <<'VERT'
// fullscreen.vert -- GLSL ES 1.00 vertex shader shared by every exported pass.
//
// The fragment shaders read gl_FragCoord directly, so this shader only needs to
// place a full-screen primitive in clip space; no varyings are required.
//
// Feed aPosition with clip-space coordinates. Two easy options:
//   * Full-screen TRIANGLE (3 verts, no index buffer):
//       (-1.0, -1.0), (3.0, -1.0), (-1.0, 3.0)
//   * Full-screen QUAD (TRIANGLE_STRIP, 4 verts):
//       (-1.0, -1.0), (1.0, -1.0), (-1.0, 1.0), (1.0, 1.0)
#version 100
attribute vec2 aPosition;
void main() {
	gl_Position = vec4(aPosition, 0.0, 1.0);
}
VERT
}

# ============================== drive it =====================================
emit_common
emit_assets

nproj=$(jq -r '.projects | length' "$f")
for ((p=0;p<nproj;p++)); do
	projname=$(jq -r --argjson p "$p" '.projects[$p].name' "$f")
	dir="$here/$(slug "$projname")"
	rm -rf "$dir"; mkdir -p "$dir"
	echo "project[$p]: $projname -> $(basename "$dir")/"
	npass=$(jq -r --argjson p "$p" '.projects[$p].layers[0].passes | length' "$f")
	for ((q=0;q<npass;q++)); do
		pname=$(jq -r --argjson p "$p" --argjson q "$q" '.projects[$p].layers[0].passes[$q].name' "$f")
		out="$dir/$(slug "$pname").frag"
		emit_frag "$p" "$q" "$out"
		echo "  pass[$q]: $pname -> $(basename "$out")"
	done
	emit_manifest "$p" "$dir"
done

echo "done."
