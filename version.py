"""Single source of truth for Grey GodZilla Anime Tracker release metadata."""

APP_NAME = "Grey GodZilla Anime Tracker"
APP_VERSION = "1.5.1"
APP_PUBLISHER = "Grey GodZilla"


def app_window_title():
    return f"{APP_NAME} v{APP_VERSION}"


def exe_filename():
    return f"{APP_NAME} v{APP_VERSION}.exe"