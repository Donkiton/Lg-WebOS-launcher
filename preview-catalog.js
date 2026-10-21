// Общие примеры для публичного предпросмотра; это не снимок личного ТВ.
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LauncherPreviewCatalog = factory();
}(this, function () {
  'use strict';
  return {
  "demo": true,
  "launchPoints": [
    {
      "id": "youtube.leanback.v4",
      "title": "YouTube",
      "icon": "assets/tv-apps/youtube.leanback.v4.png",
      "iconColor": "#ffffff"
    },
    {
      "id": "yota.play",
      "title": "Okko: кино, сериалы, спорт, ТВ",
      "icon": "assets/tv-apps/yota.play.png",
      "iconColor": "#5d0ef5"
    },
    {
      "id": "rutube",
      "title": "RUTUBE",
      "icon": "assets/tv-apps/rutube.png",
      "iconColor": "#0c0c0e"
    },
    {
      "id": "ivi",
      "title": "Иви",
      "icon": "assets/tv-apps/ivi.png",
      "iconColor": "#ffffff"
    },
    {
      "id": "de.benzac.msx",
      "title": "Media Station X",
      "icon": "assets/tv-apps/de.benzac.msx.png",
      "iconColor": "#333333"
    }
  ]
};
}));
