// LG Gate: the Movies/Rakuten (USP) remote button opens the configured Zona card.
// The launcher resolves the current MSX shortcut; this filter stores no URL.
function init() {
}

function handleUspZona(key, pressed, autoRepeat) {
    if (key !== WebOS.Key_webOS_USP) {
        return KeyPolicy.NextPolicy;
    }
    if (pressed && !autoRepeat && access.keyAction.launchApp &&
            (!bootManager.bootFirstUse || systemPropertyService.powerOnlyMode)) {
        if (nudgeView.visible) {
            nudgeView.close();
        }
        applicationManager.launch('org.lggate.launcher', '"shortcut":"zona","reason":"hotkey"', false, false);
    }
    return KeyPolicy.Accepted;
}
