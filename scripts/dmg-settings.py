# dmgbuild settings for the trial disk image, read by scripts/package-macos.mjs --dmg.
# Values passed with -D: app (the signed app bundle), background (the multi-resolution TIFF),
# shortcut (the .webloc that opens System Settings > Privacy & Security).
# The window layout matches assets/dmg/render-background.swift.
import os.path

application = defines["app"]  # noqa: F821 (provided by dmgbuild)
app_name = os.path.basename(application)
shortcut_path = defines["shortcut"]  # noqa: F821
shortcut_name = os.path.basename(shortcut_path)

format = "UDZO"
filesystem = "HFS+"
files = [application, shortcut_path]
symlinks = {"Applications": "/Applications"}
hide_extensions = [shortcut_name]

background = defines["background"]  # noqa: F821
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
window_rect = ((200, 120), (680, 540))
default_view = "icon-view"
show_icon_preview = False
arrange_by = None
icon_size = 112
text_size = 13
label_pos = "bottom"
icon_locations = {
    app_name: (170, 150),
    "Applications": (510, 150),
    shortcut_name: (340, 430),
}
