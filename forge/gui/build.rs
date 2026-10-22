//! Windows: embed the logo as the executable's icon (Explorer, taskbar, Alt+Tab). The .ico is
//! rasterized from the one SVG logo at build time, so no bitmap copy lives in the repository.

fn main() {
    println!("cargo:rerun-if-changed=assets/icon.svg");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let ico_path = out.join("vencord-forge.ico");
    let svg = std::fs::read("assets/icon.svg").expect("assets/icon.svg");
    let tree = resvg::usvg::Tree::from_data(&svg, &resvg::usvg::Options::default()).expect("valid SVG logo");

    let mut dir = ico::IconDir::new(ico::ResourceType::Icon);
    for size in [16u32, 24, 32, 48, 64, 128, 256] {
        let mut pixmap = resvg::tiny_skia::Pixmap::new(size, size).unwrap();
        let scale = size as f32 / tree.size().width().max(tree.size().height());
        resvg::render(&tree, resvg::tiny_skia::Transform::from_scale(scale, scale), &mut pixmap.as_mut());
        let rgba: Vec<u8> = pixmap
            .pixels()
            .iter()
            .flat_map(|p| {
                let c = p.demultiply();
                [c.red(), c.green(), c.blue(), c.alpha()]
            })
            .collect();
        let image = ico::IconImage::from_rgba_data(size, size, rgba);
        dir.add_entry(ico::IconDirEntry::encode(&image).expect("encode icon"));
    }
    dir.write(std::fs::File::create(&ico_path).unwrap()).unwrap();

    let mut resource = winresource::WindowsResource::new();
    resource.set_icon(ico_path.to_str().unwrap());
    resource.set("ProductName", "Vencord Forge");
    resource.set("FileDescription", "Vencord Forge");
    resource.compile().expect("embed Windows resources");
}
