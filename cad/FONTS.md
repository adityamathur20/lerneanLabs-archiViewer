# Fonts in the Drawing view

mlightcad loads fonts from `baseUrl/fonts/fonts.json` and, by default, from
`cdn.jsdelivr.net/gh/mlightcad/cad-data`. That repository has **no licence**,
and its README says the fonts in it must be licensed by the user (Autodesk SHX
fonts, Microsoft SimSun). So we serve neither the CDN nor those files.

Instead `public/cad-data/fonts/fonts.json` maps the font names drawings ask for
onto three openly licensed fonts, and a name it does not know falls back to the
first entry. Text therefore reads in a clean sans-serif rather than AutoCAD's
stroke fonts.

| File | Licence | Source |
|---|---|---|
| `LiberationSans-Regular.ttf` | SIL Open Font License 1.1 | liberation-fonts 2.1.5 release |
| `LiberationSerif-Regular.ttf` | SIL Open Font License 1.1 | same |
| `LiberationMono-Regular.ttf` | SIL Open Font License 1.1 | same |

Licence text: `public/cad-data/fonts/LICENSE-Liberation.txt`.

Not covered: CJK glyphs. A drawing whose text is Chinese or Japanese will show
missing glyphs until a CJK font (e.g. Noto Sans CJK, also OFL) is added here.
