# File previews

The **Files** tab can show many binary files without you downloading them first. Click a texture or model
(or press **Preview** on its row) and a window opens with the picture or a 3D view. Text-based models such as
`.obj` still open in the editor when you click the name; use **Preview** to see them drawn.

How it works, in plain terms: the panel downloads the file the same way the **Download** button does (so the
same permissions apply: you can only preview files you could already download), and your browser decodes it.
Nothing is uploaded anywhere and nothing in the file is run. Files over 64 MB are not previewed; download them.

## Textures

Zoom with the wheel, drag to pan, **Fit** and **1:1** to reset. The **R G B A** buttons switch channels on and
off (turn off R, G and B to see only the alpha channel), **Background** cycles checkerboard, dark and light, and
files with mip levels get a mip picker. Dimensions and the exact format are shown underneath.

| Format | Support |
| --- | --- |
| `.png .jpg .jpeg .webp .avif .bmp .ico .gif .svg` | Full (your browser draws them). SVG is shown as an image, so scripts inside it never run. |
| `.tga` | Full: indexed, grey, 15/16/24/32-bit, RLE. |
| `.dds` | DXT1/3/5, BC4, BC5, common uncompressed layouts, mip levels. Not BC7. Cube maps show the first face. |
| `.psd` `.psb` | The flattened image stored in the file (RGB, grey, indexed, CMYK; raw, RLE or zip). Layers are not shown. |
| `.tif .tiff` | Uncompressed, LZW, PackBits and deflate, 8/16-bit. No tiles or floating point. |
| `.hdr` | Radiance HDR, tone mapped. |
| `.exr` | Best effort: uncompressed, RLE and ZIP scanline files, tone mapped. PIZ/DWA/tiled files are not supported. |
| `.ktx .ktx2` | Basic: uncompressed and DXT/BC. Basis and Zstd supercompression are not supported. |
| `.vtf` | Valve textures: DXT and the common uncompressed formats, mips. |
| `.xcf` and other editor formats | Information only (what the file is, size, first bytes). |

## 3D models

A model opens in an orbit viewer: drag to rotate, Shift-drag to pan, wheel to zoom. Buttons switch
**Wireframe**, **UV checker** (a test pattern that shows how the UV map is laid out on the surface),
**Textures**, and **UV layout**, which draws the 2D UV map of the model (click a mesh in the list to show only
its UVs, drawn over its texture). **Texture** lets you try any image from the same folder, or one from your
computer, on every mesh.

Textures are found for you: an `.obj` reads its `.mtl` and the textures beside it, a `.glb` uses the images
inside it (a `.gltf` also reads its external files), and the others look beside the model for a file with the name
the material asks for.

| Format | Support |
| --- | --- |
| `.obj` (+ `.mtl`) | Full: UVs, normals, materials, polygons. |
| `.stl` `.ply` | Full: binary and ASCII. PLY colours and UVs are used. Point clouds without faces are not drawn. |
| `.glb` `.gltf` | Meshes, materials with base colour textures, node transforms. No skinning or animation. |
| `.fbx` | Binary and ASCII: mesh geometry, UVs, materials and textures, node transforms. No skinning, animation or pivots. |
| `.dae` | Collada triangles, polylists and polygons, materials and textures, node transforms. |
| `.3mf` | Meshes and build transforms. Colours and textures are not shown. |
| `.smd` | Mesh triangles with UVs. Bones are ignored. |
| `.vox` | MagicaVoxel: the first model, as coloured blocks. |

## GTA V files

These need files that are not encrypted (as exported by OpenIV or CodeWalker). Files taken directly out of the
game's archives are encrypted with the game's keys. The panel does not contain those keys and never will; for
such files it shows a message telling you to export them first.

| Format | Support |
| --- | --- |
| `.ytd` | Texture dictionary: every texture in a gallery with its name, size and format; click one for the full viewer with mips and channels. DXT1/3/5, ATI1/2 and common uncompressed formats. BC7 textures show as "not supported". |
| `.ydr` `.ydd` `.yft` | Drawable, drawable dictionary and fragment: the highest detail level of each mesh, with UVs. Textures come from the file itself if it has an embedded dictionary, otherwise from a `.ytd` in the same folder named like the model (`name.ytd`, `name_hi.ytd`, or the only `.ytd` there). Use **Pair .ytd** to pick another one or **Open .ytd** to load one from your computer. Fragments are located heuristically; damage and physics are not shown. |
| `.ybn .ymap .ytyp .ycd .ypt .yld .ymt` and other resource types | Information only: type, version and sizes. Open them in CodeWalker for the contents. |

The GTA V readers follow the community-documented layout of the PC (legacy) resource format. They were checked
against hand-built test files, not against a live game install, so an unusual file may show "layout not
recognised". GTA V Enhanced (RSC8) files are not supported.

## Information only

For these the panel shows what the file is, its size, and a few facts read from the header, but does not draw it:
`.blend` (Blender version, object/mesh/material counts and names; open it in Blender or export to glTF/OBJ to
preview), `.uasset .umap .upk .pak .vpk .bsp .mdl .vvd .vtx .nif .hkx .gr2 .skp .max .ma .mb .c4d .lwo .lws .psk
.psa .3ds .usd* .abc .sbsar .zpr .ztl`, and similar editor and engine formats.

## If a preview fails

You get the reason (for example "BC7 textures are not supported", "needs the game keys", "this browser has no
WebGL 2") plus the file's basic information. The file itself is never changed by previewing.
