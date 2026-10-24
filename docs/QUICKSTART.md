# Установить LG Gate 0.1.7 из релиза

Нужен LG **SM8200PLA**, ПО **05.40.97**, webOS **4.10.2** (поколение 4.5), **Homebrew Channel 0.7.3 с root-сервисом**. Это единственная проверенная конфигурация LG Gate. Для другой модели или прошивки сначала нужна отдельная проверка совместимости. IPK устанавливается на телевизор; компьютер нужен для первоначальной настройки.

## 1. Скачать комплект

Откройте [релиз v0.1.7](https://github.com/Donkiton/Lg-WebOS-launcher/releases/tag/v0.1.7) и скачайте:

- **`lg-gate_0.1.7_install.zip`** — готовый IPK, скрипты настройки и эта инструкция. Начните с него.
- **`SHA256SUMS.txt`** — контрольные суммы файлов релиза.
- Если root ещё нет: **`dejavuln-autoroot-0.0.10.zip`** и [инструкцию получения root](https://github.com/Donkiton/Lg-WebOS-launcher/blob/main/docs/ROOTING.md). Этот архив предназначен для флешки и используется отдельно от LG Gate. Если root и Homebrew уже работают, этот шаг не нужен.

Отдельный `org.lggate.launcher_0.1.7_all.ipk` тоже доступен в релизе для тех, у кого инструменты уже настроены. Файлы `Source code` — исходники, а не установочный комплект. Архив `corresponding-source.zip` — исходники и рецепты сборки сторонних компонентов; на флешку его не копируют.

В PowerShell вычислите хеш скачанного ZIP и сравните с одноимённой строкой `SHA256SUMS.txt`:

```powershell
Get-FileHash -Algorithm SHA256 .\lg-gate_0.1.7_install.zip
```

Распакуйте ZIP и откройте PowerShell **внутри папки `lg-gate-0.1.7`**, где находятся `package.json`, `scripts` и `dist`.

## 2. Подготовить компьютер и SSH

Установите [Node.js 20 или новее](https://nodejs.org/) и клиент OpenSSH. В Windows OpenSSH доступен как дополнительный компонент системы. Для установки из ZIP не нужны Git, Python и сборка приложения. Команды ниже рассчитаны на Windows PowerShell; на macOS/Linux пути к SSH-файлам находятся в `~/.ssh/`.

```powershell
node --version
ssh -V
npm ci --ignore-scripts
```

Телевизор и компьютер должны быть в одной локальной сети. Узнайте IP телевизора в его сетевых настройках; далее вместо `TV_IP` подставляйте этот адрес.

В Homebrew Channel → Settings включите **SSH Server** и перезагрузите ТВ через Homebrew Channel. Для этой настройки используется `root`, порт `22`. Приложение LG Developer Mode для этого способа не требуется и не должно быть установлено на рутированном ТВ. [Настройка SSH в webOS Homebrew](https://www.webosbrew.org/pages/sdk-configuration).

Если рабочий вход по SSH-ключу уже настроен, используйте свой ключ и переходите к настройке alias. Для первой настройки создайте отдельный ключ на компьютере:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE/.ssh" | Out-Null
ssh-keygen -t ed25519 -f "$env:USERPROFILE/.ssh/lg-tv"
```

Не перезаписывайте существующий ключ. Скрипты ниже работают без интерактивного ввода: используйте отдельный ключ без парольной фразы либо заранее разблокируйте ключ в SSH agent. Для LG CLI настройте фразу отдельно, если она есть. Приватный файл `lg-tv` остаётся только на компьютере.

Для первого входа новый Homebrew Channel использует пароль `alpine`, пока публичные ключи не установлены. При первом подключении сверьте отпечаток ключа узла, затем добавьте **публичный** ключ, сохранив уже существующие:

```powershell
Get-Content "$env:USERPROFILE/.ssh/lg-tv.pub" | ssh root@TV_IP "umask 077; mkdir -p /home/root/.ssh && printf '\n' >> /home/root/.ssh/authorized_keys && cat >> /home/root/.ssh/authorized_keys && chmod 700 /home/root/.ssh && chmod 600 /home/root/.ssh/authorized_keys"
ssh -i "$env:USERPROFILE/.ssh/lg-tv" -o BatchMode=yes root@TV_IP "id -u"
```

Ожидаемый ответ — `0`. После успешной проверки перезагрузите ТВ через Homebrew Channel и повторите проверку. При наличии `authorized_keys` Homebrew перестаёт устанавливать пароль по умолчанию при загрузке. [Описание доступа в Homebrew Channel](https://github.com/webosbrew/webos-homebrew-channel/tree/v0.7.3).

В `%USERPROFILE%/.ssh/config` добавьте alias (если `lg-tv` уже существует, проверьте его параметры). Замените `TV_IP` и путь своими значениями:

```sshconfig
Host lg-tv
    HostName TV_IP
    Port 22
    User root
    IdentityFile ~/.ssh/lg-tv
    IdentitiesOnly yes
```

```powershell
ssh -o BatchMode=yes lg-tv "id -u"
```

Должен вернуться `0` без запроса пароля. Этот alias используют скрипты Home и автозапуска.

## 3. Установить IPK

LG CLI использует отдельный профиль устройства. Для ключа `%USERPROFILE%/.ssh/lg-tv` без парольной фразы:

```powershell
npx --no-install ares-config --profile tv
npx --no-install ares-setup-device --add lg-tv --info "host=TV_IP" --info "port=22" --info "username=root" --info "privatekey=lg-tv"
npx --no-install ares-install --device lg-tv dist/org.lggate.launcher_0.1.7_all.ipk
npx --no-install ares-launch --device lg-tv org.lggate.launcher
```

Если профиль `lg-tv` уже есть, используйте `--modify` вместо `--add`. Для другого ключа укажите его имя внутри `.ssh`; при необходимости добавьте `--info "passphrase=ВАША_ФРАЗА"` локально. Не публикуйте настройки устройства и ключи. Команды установки описаны в [руководстве LG CLI](https://webostv.developer.lge.com/develop/tools/cli-dev-guide).

Проверьте изображение, каталог, запуск приложений, стрелки и OK. Если они работают, переходите к следующему шагу. При ошибке сохраните текст ошибки и остановитесь до изменения Home.

## 4. Назначить Home и автозапуск

```powershell
node scripts/manage-tv-home.js inspect
node scripts/manage-tv-home.js apply
node scripts/manage-tv-startup.js enable
node scripts/manage-tv-startup.js status
```

`apply` сохраняет исходный Home на ТВ в `/var/lib/lg-gate/home-original.json`. `enable` устанавливает runtime и пользовательский hook Homebrew Channel; при первой установке включает возврат после окончательного выхода из стороннего приложения. При `status` ожидаются `enabled: true`, `running: true`, `backEnabled: true`.

Проверьте Home на пульте, выход Back и запуск после перезагрузки. При холодном включении перед LG Gate может кратко появляться Live TV или прежний вход. Во время работы лаунчера компьютер можно выключить. Сохраните распакованный комплект: его команды нужны для отката.

Настройки кнопок IVI/Zona и оптимизации необязательны; они описаны в [полной инструкции](https://github.com/Donkiton/Lg-WebOS-launcher/blob/main/docs/INSTALLATION.md).

## 5. Откат

Выполните команды **до удаления приложения**, в указанном порядке:

```powershell
node scripts/manage-tv-startup.js disable
node scripts/manage-tv-home.js restore
```

После успешного восстановления штатного Home можно удалить только LG Gate:

```powershell
npx --no-install ares-install --device lg-tv --remove org.lggate.launcher
```

Удаление приложения может удалить его настройки. Откат Home не удаляет root и Homebrew Channel. Если отдельно применяли оптимизации или переназначали кнопки, сначала восстановите их командами `restore` из полной инструкции.

## Что проверено

IPK 0.1.7 установлен и проверен на LG SM8200PLA 24 октября 2026 года. SHA256 пакета: `c0e26b12d0a30f2b296b2f784c16eadf8f1b037e1110f30ab5735cd30c72ca65`; все 35 файлов сверены с исходниками. Проверены меню фонов, WebP, пульт и сохранение настроек. Публикация релиза и сборка ZIP не меняют телевизор. Установка с нуля на другом устройстве и другие модели не проверялись.

## Лицензия

Автор LG Gate — Битюцкий Вадим Алексеевич (DonKiton). Полный текст **LG Gate Proprietary Source License v1.1** находится в `LICENSE` внутри ZIP и в `LG-Gate-LICENSE.txt` релиза. Разрешено личное некоммерческое использование физическими лицами; коммерческое использование и использование организациями требуют письменного разрешения. [Исходники этой версии](https://github.com/Donkiton/Lg-WebOS-launcher/archive/refs/tags/v0.1.7.zip) доступны рядом с готовыми файлами. Сторонние компоненты сохраняют собственные лицензии.
