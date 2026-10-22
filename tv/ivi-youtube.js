// LG Gate: the dedicated IVI button opens the installed YouTube application.
// Loaded by the TV's native key-filter chain immediately before handleCPHotkeys.
// Other keys continue through the original filters unchanged.
function init() {
    // Native filter loader initialization; this rule needs no subscriptions.
}

function handleIviYoutube(key, pressed, autoRepeat) {
    if (key !== WebOS.Key_webOS_IVI) {
        return KeyPolicy.NextPolicy;
    }
    if (pressed && !autoRepeat && access.keyAction.launchApp &&
            (!bootManager.bootFirstUse || systemPropertyService.powerOnlyMode)) {
        if (nudgeView.visible) {
            nudgeView.close();
        }
        if (!(fullscreenView.activeFocus && fullscreenView.appId === 'youtube.leanback.v4')) {
            applicationManager.checkLaunch('youtube.leanback.v4', '"reason":"hotkey"', true, false);
        }
    }
    // Consume release and repeats as well, so the stock IVI action never runs.
    return KeyPolicy.Accepted;
}
