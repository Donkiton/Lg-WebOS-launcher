# Сторонний инструмент получения root: происхождение и лицензии

LG Gate распространяется отдельно от DejaVuln Autoroot. Архив
`dejavuln-autoroot-0.0.10.zip` является неизменённым выпуском **throwaway96**,
а не разработкой LG Gate. Уязвимость DejaVuln обнаружил **Jacob Clayden**.
Оригинальные сведения об авторах, правах и отсутствии гарантий сохранены.

- Официальный выпуск: <https://github.com/throwaway96/dejavuln-autoroot/releases/tag/v0.0.10>.
- Исходный commit: `8573d2a43a8aa2c213f6c25336fd1919a0a4260c`.
- SHA256 ZIP: `83f39e95ec702e6370df65bde16acced9861a87e473f763a9e55de948aa7756f`.
- Лицензия скрипта: **AGPL-3.0-or-later**, полный текст приложен отдельно в
  `dejavuln-autoroot-AGPL-3.0.txt` и сохранён как `COPYING` в исходниках.
- Вложенный `hbchannel.ipk` — **webOS Homebrew Channel 0.7.3**, SHA256
  `d10bf3c753551d7c72fb7a92b20fcd2317e502a220ac668ba8e76f6ea78b363c`.
  Он побайтово соответствует upstream IPK этого выпуска.
- Homebrew Channel: <https://github.com/webosbrew/webos-homebrew-channel/releases/tag/v0.7.3>,
  commit `92fcf9fef7ce08dbeae3b0616df8d0c75c11f0b3`, автор — webOS Brew и его участники.

Изменения в сторонние ZIP, IPK, скрипт, исходные архивы и шрифты не вносились.
Добавлены только этот сопроводительный документ, манифест и комплект исходников.
Настройки и данные какого-либо телевизора в сторонние артефакты не включаются.

## Комплект исходников

В этом же GitHub Release размещается
`dejavuln-autoroot-0.0.10-corresponding-source.zip`. В его корне находятся
`root-tool.json` и `ROOT-TOOL-NOTICES.md`, в каталоге `sources/` — исходные
архивы, перечисленные в поле `sources` манифеста. Для каждого указаны
конкретный URL и проверенный SHA256. Архивы npm дополнительно сверены с
`integrity` из upstream `package-lock.json`. Скачать исходники можно бесплатно
рядом с бинарным архивом, без установки на телевизор.

Комплект включает DejaVuln, Homebrew Channel, все семь его git submodules,
все 37 пакетов в графе runtime-зависимостей из зафиксированного npm lockfile
(36 различных исходных архивов, поскольку `safe-buffer` используется дважды),
а также исходники встроенных BusyBox, rsync, Dropbear и OpenSSH.
Для DOMPurify дополнительно включён полный исходный репозиторий версии 3.0.1,
commit `e42464f0e06ab5899aae41c89920be9af8b2e826`: npm-архив этого пакета
содержит преимущественно готовые файлы `dist/` и source maps.
Поэтому исходники Homebrew Channel не подменяются одним архивом DejaVuln,
содержащим только готовый `hbchannel.ipk`.

Полные лицензии и copyright notices включены в соответствующие исходные
архивы; точные пути приведены ниже. Лицензия основного кода Homebrew Channel
— MIT, но она не заменяет отдельные лицензии его зависимостей:

| Компонент | Версия | Условия |
| --- | --- | --- |
| DejaVuln Autoroot | 0.0.10 | AGPL-3.0-or-later |
| Homebrew Channel | 0.7.3 | MIT; компоненты сохраняют свои лицензии |
| `@throwaway96/node-load-cert-dir` | commit `b1943cb64ccb5851c6c8885892716638d954b3f6` | AGPL-3.0-or-later |
| BusyBox (`telnetd`) | 1.36.1 | GPLv2, полный текст `LICENSE` |
| rsync | 3.2.7 | GPLv3 и исключение из `COPYING`; включены исходники popt и zlib |
| Dropbear и scp | 2022.83 | Набор разрешительных лицензий из `LICENSE`, включая LibTomCrypt/LibTomMath |
| OpenSSH (`sftp-server`) | 9.1p1 | BSD и другие разрешительные условия из `LICENCE` |
| Enyo, Moonstone, Spotlight, Layout, SVG, webOS/ilib | git commits из таблицы ниже | Условия в исходниках; основной код Enyo — Apache-2.0 |
| Miso и Museo Sans в Moonstone | исходные файлы upstream | Отдельные Font License; использование ограничено Enyo-приложениями |
| Остальные JavaScript-пакеты | версии из таблицы ниже | Исходные LICENSE каждого пакета; DOMPurify имеет отдельную двойную лицензию |

Шрифты Moonstone не предлагаются как самостоятельные шрифты для LG Gate
или произвольного использования. Сохраняются их исходные условия
`fonts/Miso/LICENSE.txt` и `fonts/MuseoSans/LICENSE.txt`.

## Рецепты сборки и конфигурация

После распаковки `webos-homebrew-channel-0.7.3-source.tar.gz` в каталоге
`webos-homebrew-channel-92fcf9fef7ce08dbeae3b0616df8d0c75c11f0b3/` доступны:

- `tools/build-binaries.sh`: URL, SHA256, toolchain, параметры конфигурации и
  сборки всех четырёх native-компонентов;
- `tools/patches/dropbear-2022.83-webos-v1.patch`: изменения Dropbear для webOS;
- `package.json`, `package-lock.json`, `webpack.config.js`, `babel.config.json`,
  `.enyoconfig`, `.github/workflows/build.yml`, `.github/workflows/build-binaries.yml`:
  рецепты и зафиксированные зависимости frontend/service;
- `.gitmodules`: соответствие каталогов `lib/*` исходным репозиториям.

GitHub не добавляет содержимое submodules в автоматический архив. Поэтому
их исходники приложены отдельно. Для восстановления дерева нужно распаковать
каждый архив из таблицы в указанный каталог, убрав его единственный внешний
каталог. Runtime npm-пакеты восстанавливаются аналогично в пути `node_modules/*`.
Доступные отдельно общие инструменты сборки устанавливаются по upstream README;
в комплект не входят бинарные SDK и инструменты разработчика.

Для BusyBox исходный рецепт создаёт `.config` командой `make allnoconfig` и
устанавливает следующие значения; этот фрагмент и полный рецепт сохранены:

```text
CONFIG_SHOW_USAGE=y
CONFIG_FEATURE_VERBOSE_USAGE=y
CONFIG_FEATURE_COMPRESS_USAGE=y
CONFIG_FEATURE_DEVPTS=y
CONFIG_LFS=y
CONFIG_TELNETD=y
CONFIG_FEATURE_TELNETD_STANDALONE=y
CONFIG_FEATURE_TELNETD_PORT_DEFAULT=23
```

Остальные параметры остаются значениями `allnoconfig` исходной BusyBox 1.36.1.
Функция `build_telnetd` выполняет сборку и копирует полученный BusyBox как
`services/bin/telnetd`. Параметры rsync, включённые popt/zlib и параметры
OpenSSH/Dropbear сохранены непосредственно в том же `build-binaries.sh`.

Архив DejaVuln содержит `Makefile`: он упаковывает `autoroot.sh`,
`hbchannel.ipk` и два специальных медиафайла. Исходный `autoroot.sh` оставлен
без исправления fallback URL Homebrew 0.7.2: штатный выпуск 0.0.10 использует
приложенный Homebrew 0.7.3. Для установки следует сохранять весь исходный ZIP.

Исходники привязаны к опубликованным тегам, commit и рецептам upstream.
Побайтовая воспроизводимость сторонних бинарников не заявляется: они здесь
не пересобирались. Скрипты получения root при подготовке комплекта не запускались.

## Соответствие каталогов исходникам

Таблица относится к дереву исходников Homebrew Channel, а не к каталогам
на пользовательском телевизоре.

| Каталог после восстановления | Исходный архив | Commit или версия |
| --- | --- | --- |
| `lib/enyo` | `sources/enyojs-enyo-514d966a1465e93aae0c3ba96ce64c570b161e53.tar.gz` | `514d966a1465e93aae0c3ba96ce64c570b161e53` |
| `lib/enyo-ilib` | `sources/enyojs-enyo-ilib-8c26cea5ea6eb0e393f00b96c8af0eac8cc0387a.tar.gz` | `8c26cea5ea6eb0e393f00b96c8af0eac8cc0387a` |
| `lib/enyo-webos` | `sources/enyojs-enyo-webos-eff99a6f78eed8a0828988eb1bea59ea7efba9cc.tar.gz` | `eff99a6f78eed8a0828988eb1bea59ea7efba9cc` |
| `lib/layout` | `sources/enyojs-layout-77803c63b0858c86ceefdce922f67fce12abdd34.tar.gz` | `77803c63b0858c86ceefdce922f67fce12abdd34` |
| `lib/moonstone` | `sources/enyojs-moonstone-7348fbb47cac3757edc97ed513adebbd605eacf1.tar.gz` | `7348fbb47cac3757edc97ed513adebbd605eacf1` |
| `lib/spotlight` | `sources/enyojs-spotlight-0589121de0810dfb3ad5d90ea59563ec3a303d4b.tar.gz` | `0589121de0810dfb3ad5d90ea59563ec3a303d4b` |
| `lib/svg` | `sources/enyojs-svg-860ed9e6014820b1715b5d99817a0faa3683020a.tar.gz` | `860ed9e6014820b1715b5d99817a0faa3683020a` |
| `node_modules/@throwaway96/node-load-cert-dir` | `sources/throwaway96-node-load-cert-dir-b1943cb64ccb5851c6c8885892716638d954b3f6.tar.gz` | `b1943cb64ccb5851c6c8885892716638d954b3f6` |
| `node_modules/bluebird` | `sources/npm-bluebird-3.7.2.tgz` | `3.7.2` |
| `node_modules/core-js` | `sources/npm-core-js-3.36.0.tgz` | `3.36.0` |
| `node_modules/core-util-is` | `sources/npm-core-util-is-1.0.3.tgz` | `1.0.3` |
| `node_modules/define-data-property` | `sources/npm-define-data-property-1.1.4.tgz` | `1.1.4` |
| `node_modules/define-properties` | `sources/npm-define-properties-1.2.1.tgz` | `1.2.1` |
| `node_modules/dompurify` | `sources/npm-dompurify-3.0.1.tgz` | `3.0.1` |
| `node_modules/es-define-property` | `sources/npm-es-define-property-1.0.0.tgz` | `1.0.0` |
| `node_modules/es-errors` | `sources/npm-es-errors-1.3.0.tgz` | `1.3.0` |
| `node_modules/function-bind` | `sources/npm-function-bind-1.1.2.tgz` | `1.1.2` |
| `node_modules/get-intrinsic` | `sources/npm-get-intrinsic-1.2.4.tgz` | `1.2.4` |
| `node_modules/gopd` | `sources/npm-gopd-1.0.1.tgz` | `1.0.1` |
| `node_modules/has-property-descriptors` | `sources/npm-has-property-descriptors-1.0.2.tgz` | `1.0.2` |
| `node_modules/has-proto` | `sources/npm-has-proto-1.0.3.tgz` | `1.0.3` |
| `node_modules/has-symbols` | `sources/npm-has-symbols-1.0.3.tgz` | `1.0.3` |
| `node_modules/hasown` | `sources/npm-hasown-2.0.1.tgz` | `2.0.1` |
| `node_modules/inherits` | `sources/npm-inherits-2.0.4.tgz` | `2.0.4` |
| `node_modules/isarray` | `sources/npm-isarray-1.0.0.tgz` | `1.0.0` |
| `node_modules/node-fetch` | `sources/npm-node-fetch-2.6.7.tgz` | `2.6.7` |
| `node_modules/object-keys` | `sources/npm-object-keys-1.1.1.tgz` | `1.1.1` |
| `node_modules/process-nextick-args` | `sources/npm-process-nextick-args-2.0.1.tgz` | `2.0.1` |
| `node_modules/progress-stream` | `sources/npm-progress-stream-2.0.0.tgz` | `2.0.0` |
| `node_modules/readable-stream` | `sources/npm-readable-stream-2.3.8.tgz` | `2.3.8` |
| `node_modules/readable-stream/node_modules/safe-buffer` | `sources/npm-safe-buffer-5.1.2.tgz` | `5.1.2` |
| `node_modules/regenerator-runtime` | `sources/npm-regenerator-runtime-0.14.1.tgz` | `0.14.1` |
| `node_modules/speedometer` | `sources/npm-speedometer-1.0.0.tgz` | `1.0.0` |
| `node_modules/stream.finished` | `sources/npm-stream.finished-1.2.0.tgz` | `1.2.0` |
| `node_modules/stream.pipeline-shim` | `sources/npm-stream.pipeline-shim-1.1.0.tgz` | `1.1.0` |
| `node_modules/string_decoder` | `sources/npm-string_decoder-1.1.1.tgz` | `1.1.1` |
| `node_modules/through2` | `sources/npm-through2-2.0.5.tgz` | `2.0.5` |
| `node_modules/through2/node_modules/xtend` | `sources/npm-xtend-4.0.2.tgz` | `4.0.2` |
| `node_modules/tr46` | `sources/npm-tr46-0.0.3.tgz` | `0.0.3` |
| `node_modules/util-deprecate` | `sources/npm-util-deprecate-1.0.2.tgz` | `1.0.2` |
| `node_modules/webidl-conversions` | `sources/npm-webidl-conversions-3.0.1.tgz` | `3.0.1` |
| `node_modules/webos-service` | `sources/webosose-nodejs-module-webos-service-1dd2c9d6cd21eb5d84f7619432ed6d2784bb56f9.tar.gz` | `1dd2c9d6cd21eb5d84f7619432ed6d2784bb56f9` |
| `node_modules/whatwg-url` | `sources/npm-whatwg-url-5.0.0.tgz` | `5.0.0` |

## Пути к полным лицензиям и уведомлениям

В первой колонке указан архив внутри каталога `sources/`, во второй — путь
внутри этого архива. Эти файлы предоставляются целиком вместе с исходниками.
Уведомления в заголовках отдельных исходных файлов также сохранены.

| Архив | Полный текст лицензии / уведомления |
| --- | --- |
| `dejavuln-autoroot-0.0.10-source.tar.gz` | `dejavuln-autoroot-8573d2a43a8aa2c213f6c25336fd1919a0a4260c/COPYING` |
| `webos-homebrew-channel-0.7.3-source.tar.gz` | `webos-homebrew-channel-92fcf9fef7ce08dbeae3b0616df8d0c75c11f0b3/LICENSE` |
| `busybox-1.36.1.tar.bz2` | `busybox-1.36.1/LICENSE` |
| `busybox-1.36.1.tar.bz2` | `busybox-1.36.1/archival/libarchive/bz/LICENSE` |
| `rsync-3.2.7.tar.gz` | `rsync-3.2.7/COPYING` |
| `rsync-3.2.7.tar.gz` | `rsync-3.2.7/popt/COPYING` |
| `dropbear-2022.83.tar.gz` | `dropbear-DROPBEAR_2022.83/LICENSE` |
| `dropbear-2022.83.tar.gz` | `dropbear-DROPBEAR_2022.83/libtomcrypt/LICENSE` |
| `dropbear-2022.83.tar.gz` | `dropbear-DROPBEAR_2022.83/libtommath/LICENSE` |
| `openssh-9.1p1.tar.gz` | `openssh-9.1p1/LICENCE` |
| `enyojs-enyo-514d966a1465e93aae0c3ba96ce64c570b161e53.tar.gz` | `enyo-514d966a1465e93aae0c3ba96ce64c570b161e53/LICENSE-2.0.txt` |
| `enyojs-enyo-ilib-8c26cea5ea6eb0e393f00b96c8af0eac8cc0387a.tar.gz` | `enyo-ilib-8c26cea5ea6eb0e393f00b96c8af0eac8cc0387a/LICENSE-2.0.txt` |
| `enyojs-enyo-webos-eff99a6f78eed8a0828988eb1bea59ea7efba9cc.tar.gz` | `enyo-webos-eff99a6f78eed8a0828988eb1bea59ea7efba9cc/tools/node_modules/async/LICENSE` |
| `enyojs-enyo-webos-eff99a6f78eed8a0828988eb1bea59ea7efba9cc.tar.gz` | `enyo-webos-eff99a6f78eed8a0828988eb1bea59ea7efba9cc/webOS/LICENSE-2.0.txt` |
| `enyojs-layout-77803c63b0858c86ceefdce922f67fce12abdd34.tar.gz` | `layout-77803c63b0858c86ceefdce922f67fce12abdd34/LICENSE-2.0.txt` |
| `enyojs-moonstone-7348fbb47cac3757edc97ed513adebbd605eacf1.tar.gz` | `moonstone-7348fbb47cac3757edc97ed513adebbd605eacf1/LICENSE-2.0.txt` |
| `enyojs-moonstone-7348fbb47cac3757edc97ed513adebbd605eacf1.tar.gz` | `moonstone-7348fbb47cac3757edc97ed513adebbd605eacf1/fonts/Miso/LICENSE.txt` |
| `enyojs-moonstone-7348fbb47cac3757edc97ed513adebbd605eacf1.tar.gz` | `moonstone-7348fbb47cac3757edc97ed513adebbd605eacf1/fonts/MuseoSans/LICENSE.txt` |
| `enyojs-spotlight-0589121de0810dfb3ad5d90ea59563ec3a303d4b.tar.gz` | `spotlight-0589121de0810dfb3ad5d90ea59563ec3a303d4b/LICENSE-2.0.txt` |
| `throwaway96-node-load-cert-dir-b1943cb64ccb5851c6c8885892716638d954b3f6.tar.gz` | `node-load-cert-dir-b1943cb64ccb5851c6c8885892716638d954b3f6/COPYING` |
| `npm-bluebird-3.7.2.tgz` | `package/LICENSE` |
| `npm-core-js-3.36.0.tgz` | `package/LICENSE` |
| `npm-core-util-is-1.0.3.tgz` | `package/LICENSE` |
| `npm-define-data-property-1.1.4.tgz` | `package/LICENSE` |
| `npm-define-properties-1.2.1.tgz` | `package/LICENSE` |
| `npm-dompurify-3.0.1.tgz` | `package/LICENSE` |
| `npm-es-define-property-1.0.0.tgz` | `package/LICENSE` |
| `npm-es-errors-1.3.0.tgz` | `package/LICENSE` |
| `npm-function-bind-1.1.2.tgz` | `package/LICENSE` |
| `npm-get-intrinsic-1.2.4.tgz` | `package/LICENSE` |
| `npm-gopd-1.0.1.tgz` | `package/LICENSE` |
| `npm-has-property-descriptors-1.0.2.tgz` | `package/LICENSE` |
| `npm-has-proto-1.0.3.tgz` | `package/LICENSE` |
| `npm-has-symbols-1.0.3.tgz` | `package/LICENSE` |
| `npm-hasown-2.0.1.tgz` | `package/LICENSE` |
| `npm-inherits-2.0.4.tgz` | `package/LICENSE` |
| `npm-node-fetch-2.6.7.tgz` | `package/LICENSE.md` |
| `npm-object-keys-1.1.1.tgz` | `package/LICENSE` |
| `npm-process-nextick-args-2.0.1.tgz` | `package/license.md` |
| `npm-progress-stream-2.0.0.tgz` | `package/LICENSE` |
| `npm-readable-stream-2.3.8.tgz` | `package/LICENSE` |
| `npm-safe-buffer-5.1.2.tgz` | `package/LICENSE` |
| `npm-regenerator-runtime-0.14.1.tgz` | `package/LICENSE` |
| `npm-speedometer-1.0.0.tgz` | `package/LICENSE` |
| `npm-stream.finished-1.2.0.tgz` | `package/LICENSE` |
| `npm-stream.pipeline-shim-1.1.0.tgz` | `package/LICENSE` |
| `npm-string_decoder-1.1.1.tgz` | `package/LICENSE` |
| `npm-through2-2.0.5.tgz` | `package/LICENSE.md` |
| `npm-xtend-4.0.2.tgz` | `package/LICENSE` |
| `npm-util-deprecate-1.0.2.tgz` | `package/LICENSE` |
| `npm-webidl-conversions-3.0.1.tgz` | `package/LICENSE.md` |
| `webosose-nodejs-module-webos-service-1dd2c9d6cd21eb5d84f7619432ed6d2784bb56f9.tar.gz` | `nodejs-module-webos-service-1dd2c9d6cd21eb5d84f7619432ed6d2784bb56f9/LICENSE` |
| `npm-whatwg-url-5.0.0.tgz` | `package/LICENSE.txt` |
| `dompurify-3.0.1-source.tar.gz` | `DOMPurify-e42464f0e06ab5899aae41c89920be9af8b2e826/LICENSE` |
| `dompurify-3.0.1-source.tar.gz` | `DOMPurify-e42464f0e06ab5899aae41c89920be9af8b2e826/src/license_header` |

## Лицензия основного кода Homebrew Channel

```text
MIT License

Copyright (c) 2021 webOS Brew

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Проверка совместимости перед установкой

Инструкция upstream: <https://github.com/throwaway96/dejavuln-autoroot/tree/v0.0.10#instructions>.
База совместимости: <https://cani.rootmy.tv/?q=65SM8200PLA+05.40.97>.

На 24 октября 2026 года база связывает SM8200PLA с OTAID
`HE_DTV_W19P_AFADABAA` (`goldilocks2`) и указывает для DejaVuln последнюю
известную совместимую прошивку `05.40.97`, system release `4.10.2-29`.
Порог исправления DejaVuln для этой ветки в базе не указан. Это не обещание
совместимости с последующими прошивками или любым другим LG.
Для этого же OTAID RootMyTV отмечен исправленным с `05.20.15`, а crashd и ASM
— с `05.40.20`; они не описывают использованный USB-метод.

Фактически проверенная конфигурация проекта: LG 65SM8200PLA, ПО `05.40.97`,
`Rockhopper release 4.10.2-29 (goldilocks2-grampians)`, Luna `sdkVersion=4.10.0`,
поколение webOS TV 4.5. Номера прошивки, system release и SDK различаются.
Данные конкретного телевизора и журналы в выпускаемые архивы не включаются.
