# RotorLens application icon provenance

The official Android launcher artwork is
`android/app/src/main/res/drawable-nodpi/ic_launcher_artwork.png`:

- 432 × 432 pixels, opaque RGB PNG;
- SHA-256 `dad023f829b945a33dc90390c0390114d9dc9c160c2d21afe59f6d40d7fb5719`;
- first recorded in RotorLens commit
  `81bfe6cecee48963547abf5cc38033339871e8fc`, authored by Michael Wallace;
- created specifically for RotorLens through an AI-assisted design workflow
  directed by Michael Wallace, then selected, reviewed, and integrated by him;
- not copied from a stock library, another application, Rotorflight, Betaflight,
  or a third-party logo to the project's knowledge.

The artwork depicts a two-blade helicopter rotor over an optical measurement
lens and an orange tuning trace. The accompanying Android XML supplies the
adaptive safe area, black background, round launcher definition, and separately
drawn monochrome themed icon.

The PNG and RotorLens-authored XML are distributed under MPL-2.0 to the extent
copyright subsists in them. AI tooling is not identified as an author or
copyright holder. The `RotorLens` name and official-build presentation remain
subject to [`TRADEMARKS.md`](../TRADEMARKS.md).

The current 432-pixel Android raster is not an Apple App Store master. Before an
iOS release, create and review a native opaque 1024 × 1024 master, generate the
required AppIcon asset catalog, and test the result on both iPhone and iPad. Do
not silently upscale this Android raster and call that proof complete.
