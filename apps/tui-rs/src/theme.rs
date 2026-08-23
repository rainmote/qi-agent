use ratatui::style::Color;

#[derive(Clone, Debug, PartialEq)]
pub struct Theme {
    pub name: &'static str,
    pub background: Color,
    pub primary: Color,
    pub secondary: Color,
    pub accent: Color,
    pub link: Color,
    pub focused: Color,
    pub success: Color,
    pub warning: Color,
    pub error: Color,
    pub gradient: [Color; 3],
}

pub const THEME_NAMES: &[&str] = &[
    "Auto (detect terminal theme)",
    "Qwen Light",
    "Qwen Dark",
    "ANSI",
    "Atom One",
    "Ayu",
    "Default",
    "Dracula",
    "GitHub",
    "Shades Of Purple",
    "ANSI Light",
    "Ayu Light",
    "Default Light",
    "GitHub Light",
    "Google Code",
    "Xcode",
];

fn rgb(hex: u32) -> Color {
    Color::Rgb(
        ((hex >> 16) & 0xff) as u8,
        ((hex >> 8) & 0xff) as u8,
        (hex & 0xff) as u8,
    )
}

pub fn named(name: &str) -> Theme {
    match name {
        "Qwen Light" => Theme {
            name: "Qwen Light",
            background: rgb(0xFAFAFA),
            primary: Color::Black,
            secondary: rgb(0x97A0B0),
            accent: rgb(0x8B5CF6),
            link: rgb(0x3B82F6),
            focused: rgb(0x3B82F6),
            success: rgb(0x3CA84B),
            warning: rgb(0xD5A40A),
            error: rgb(0xDD4C4C),
            gradient: [rgb(0x4796E4), rgb(0x847ACE), rgb(0xC3677F)],
        },
        "ANSI Light" | "Default Light" => Theme {
            name: "Default Light",
            background: rgb(0xFAFAFA),
            primary: Color::Black,
            secondary: rgb(0x97A0B0),
            accent: rgb(0x8B5CF6),
            link: rgb(0x3B82F6),
            focused: rgb(0x3B82F6),
            success: rgb(0x3CA84B),
            warning: rgb(0xD5A40A),
            error: rgb(0xDD4C4C),
            gradient: [rgb(0x4796E4), rgb(0x847ACE), rgb(0xC3677F)],
        },
        "Ayu Light" => Theme {
            name: "Ayu Light",
            background: rgb(0xF8F9FA),
            primary: rgb(0x5C6166),
            secondary: rgb(0xA6AAAF),
            accent: rgb(0xA37ACC),
            link: rgb(0x399EE6),
            focused: rgb(0x399EE6),
            success: rgb(0x86B300),
            warning: rgb(0xF2AE49),
            error: rgb(0xF07171),
            gradient: [rgb(0x399EE6), rgb(0x86B300), rgb(0x86B300)],
        },
        "GitHub Light" => Theme {
            name: "GitHub Light",
            background: rgb(0xF8F8F8),
            primary: rgb(0x24292E),
            secondary: rgb(0x999999),
            accent: rgb(0x990000),
            link: rgb(0x445588),
            focused: rgb(0x445588),
            success: rgb(0x008080),
            warning: rgb(0x990073),
            error: rgb(0xDD1144),
            gradient: [rgb(0x445588), rgb(0x008080), rgb(0x008080)],
        },
        "Google Code" => Theme {
            name: "Google Code",
            background: Color::White,
            primary: rgb(0x444444),
            secondary: rgb(0x97A0B0),
            accent: rgb(0x660066),
            link: rgb(0x000088),
            focused: rgb(0x000088),
            success: rgb(0x008800),
            warning: rgb(0x666600),
            error: rgb(0x880000),
            gradient: [rgb(0x006666), rgb(0x660066), rgb(0x660066)],
        },
        "Xcode" => Theme {
            name: "Xcode",
            background: Color::White,
            primary: rgb(0x444444),
            secondary: rgb(0xC0C0C0),
            accent: rgb(0xAA0D91),
            link: rgb(0x1C00CF),
            focused: rgb(0x1C00CF),
            success: rgb(0x007400),
            warning: rgb(0x836C28),
            error: rgb(0xC41A16),
            gradient: [rgb(0x1C00CF), rgb(0x007400), rgb(0x007400)],
        },
        "Dracula" => Theme {
            name: "Dracula",
            background: rgb(0x282A36),
            primary: rgb(0xA3AFB7),
            secondary: rgb(0x6272A4),
            accent: rgb(0xFF79C6),
            link: rgb(0x8BE9FD),
            focused: rgb(0x8BE9FD),
            success: rgb(0x50FA7B),
            warning: rgb(0xFFF783),
            error: rgb(0xFF5555),
            gradient: [rgb(0xFF79C6), rgb(0x8BE9FD), rgb(0x50FA7B)],
        },
        "Ayu" => Theme {
            name: "Ayu",
            background: rgb(0x0B0E14),
            primary: rgb(0xAEACA6),
            secondary: rgb(0x3D4149),
            accent: rgb(0xD2A6FF),
            link: rgb(0x39BAE6),
            focused: rgb(0x39BAE6),
            success: rgb(0xAAD94C),
            warning: rgb(0xFFB454),
            error: rgb(0xF26D78),
            gradient: [rgb(0xFFB454), rgb(0xF26D78), rgb(0xF26D78)],
        },
        "Atom One" => Theme {
            name: "Atom One",
            background: rgb(0x282C34),
            primary: rgb(0xABB2BF),
            secondary: rgb(0x5C6370),
            accent: rgb(0xC678DD),
            link: rgb(0x61AEEE),
            focused: rgb(0x61AEEE),
            success: rgb(0x98C379),
            warning: rgb(0xE6C07B),
            error: rgb(0xE06C75),
            gradient: [rgb(0x61AEEE), rgb(0x98C379), rgb(0x98C379)],
        },
        "GitHub" => Theme {
            name: "GitHub",
            background: rgb(0x24292E),
            primary: rgb(0xC0C4C8),
            secondary: rgb(0x6A737D),
            accent: rgb(0xB392F0),
            link: rgb(0x79B8FF),
            focused: rgb(0x79B8FF),
            success: rgb(0x85E89D),
            warning: rgb(0xFFAB70),
            error: rgb(0xF97583),
            gradient: [rgb(0x79B8FF), rgb(0x85E89D), rgb(0x85E89D)],
        },
        "Shades Of Purple" => Theme {
            name: "Shades Of Purple",
            background: rgb(0x2D2B57),
            primary: rgb(0xE3DFFF),
            secondary: rgb(0x726C86),
            accent: rgb(0xAC65FF),
            link: rgb(0xA599E9),
            focused: rgb(0xA599E9),
            success: rgb(0xA5FF90),
            warning: rgb(0xFAD000),
            error: rgb(0xFF628C),
            gradient: [rgb(0x4D21FC), rgb(0x847ACE), rgb(0xFF628C)],
        },
        "Default" | "ANSI" | "auto" | "Auto (detect terminal theme)" => Theme {
            name: "Qwen Dark",
            background: rgb(0x1E1E2E),
            primary: Color::Reset,
            secondary: rgb(0x6C7086),
            accent: rgb(0xCBA6F7),
            link: rgb(0x89B4FA),
            focused: rgb(0x89B4FA),
            success: rgb(0xA6E3A1),
            warning: rgb(0xF9E2AF),
            error: rgb(0xF38BA8),
            gradient: [rgb(0x4796E4), rgb(0x847ACE), rgb(0xC3677F)],
        },
        _ => Theme {
            name: "Qwen Dark",
            background: rgb(0x1E1E2E),
            primary: Color::Reset,
            secondary: rgb(0x6C7086),
            accent: rgb(0xCBA6F7),
            link: rgb(0x89B4FA),
            focused: rgb(0x89B4FA),
            success: rgb(0xA6E3A1),
            warning: rgb(0xF9E2AF),
            error: rgb(0xF38BA8),
            gradient: [rgb(0x4796E4), rgb(0x847ACE), rgb(0xC3677F)],
        },
    }
}

impl Default for Theme {
    fn default() -> Self {
        named("Qwen Dark")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_the_same_builtin_theme_names_as_the_ink_baseline() {
        assert_eq!(THEME_NAMES.len(), 16);
        assert_eq!(THEME_NAMES[1], "Qwen Light");
        assert_eq!(THEME_NAMES[2], "Qwen Dark");
        assert!(THEME_NAMES.contains(&"Dracula"));
        assert!(!THEME_NAMES.contains(&"midnight"));
    }

    #[test]
    fn theme_selection_changes_the_complete_semantic_palette() {
        let qwen = named("Qwen Dark");
        let dracula = named("Dracula");
        let light = named("Qwen Light");
        assert_ne!(qwen.background, dracula.background);
        assert_ne!(qwen.accent, dracula.accent);
        assert_ne!(qwen.background, light.background);
        assert_eq!(light.background, rgb(0xFAFAFA));
    }
}
