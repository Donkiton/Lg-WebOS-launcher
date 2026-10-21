# Установка LG Gate

[← На главную](../README.md)

Для полноценной работы нужны существующий root-доступ и Homebrew Channel с root-сервисом. Отдельной программы получения root в репозитории нет. Проверенная конфигурация: LG SM8200PLA, webOS 4.5, прошивка 05.40.97, Homebrew Channel 0.7.3.

## 1. Подготовить проект

Для предпросмотра нужен Node.js 18+. Для сборки используйте Node.js 20+; публикация проверена на Node.js 24.14.0. Для полного набора тестов нужен Python 3, доступный как `python` (либо задайте путь переменной `PYTHON`).

```powershell
git clone https://github.com/Donkiton/Lg-WebOS-launcher.git
cd Lg-WebOS-launcher
npm ci --ignore-scripts
npm test
```

Предпросмотр запускается командой `npm start` по адресу <http://127.0.0.1:4173>. Публичный каталог содержит шесть примеров приложений без индивидуальных дат установки. Запуск приложений и состояние сети в браузере имитируются; установленный на ТВ лаунчер получает данные самого телевизора.

## 2. Получить IPK

Можно взять готовый файл в [папке dist](../dist/) или собрать его:

```powershell
npm run package:tv
```

Результат: `dist/org.lggate.launcher_0.1.0_all.ipk`. Сборка содержит 11 файлов приложения; сервер предпросмотра, тесты и данные личного телевизора в IPK не включаются.

## 3. Установить приложение на телевизор

Сначала подготовьте совместимый Homebrew Channel и root-доступ на своём телевизоре. В LG CLI настройте профиль устройства с именем `lg-tv`, используя свой адрес, порт и существующий способ SSH-аутентификации:

```powershell
npx --no-install ares-setup-device
npx --no-install ares-install --device lg-tv dist/org.lggate.launcher_0.1.0_all.ipk
npx --no-install ares-launch --device lg-tv org.lggate.launcher
```

Профиль LG CLI и SSH alias из следующего шага настраиваются отдельно. После запуска проверьте каталог, запуск приложений и управление пультом, прежде чем назначать новый Home. Node.js-сервер на ПК для работы установленного лаунчера не нужен.

## 4. Настроить Home и автозапуск

Скрипты используют OpenSSH `ssh` и `scp` с alias `lg-tv`, сохранённым ключом узла и входом по ключу без интерактивного запроса. Настройте их локально; адреса и ключи в репозиторий не добавляйте. На Windows конфигурация находится в `%USERPROFILE%/.ssh/config`. Замените `TV_IP`, `SSH_PORT` и путь к ключу своими значениями:

```sshconfig
Host lg-tv
    HostName TV_IP
    Port SSH_PORT
    User root
    IdentityFile ~/.ssh/lg-tv
    IdentitiesOnly yes
```

Проверьте отпечаток ключа узла при первом подключении и убедитесь, что команда `ssh lg-tv "id -u"` возвращает `0`. На проверенной прошивке runtime использует штатный `/usr/bin/python` 2.7 и пользовательские init.d hook Homebrew Channel.

```powershell
node scripts/manage-tv-home.js inspect
node scripts/manage-tv-home.js apply
node scripts/manage-tv-startup.js enable
node scripts/manage-tv-startup.js status
```

`apply` сохраняет исходное назначение Home на ТВ в `/var/lib/lg-gate/home-original.json`. `enable` устанавливает собственный hook и runtime; при первой установке включается также возврат Back. После холодного старта лаунчер открывается, когда готовы службы Homebrew; возможен начальный показ Live TV или последнего входа.

## 5. Проверить управление и откат

Стрелки перемещают фокус, OK запускает приложение, синяя кнопка открывает его действия. В каталоге для этого также есть режим «Настроить». Кнопка Home возвращает LG Gate. Внутри сторонних приложений Back сначала работает штатно; после окончательного выхода наблюдатель возвращает лаунчер.

Чтобы выключить только возврат Back:

```powershell
node scripts/manage-tv-startup.js back-disable
```

Для полного отката Home выполните команды в этом порядке **до удаления IPK**:

```powershell
node scripts/manage-tv-startup.js disable
node scripts/manage-tv-home.js restore
```

После успешного отката приложение можно удалить обычным способом или через `npx --no-install ares-install --device lg-tv --remove org.lggate.launcher`. Если отдельно применяли `manage-tv-optimizations.js apply`, его настройки возвращаются командой `node scripts/manage-tv-optimizations.js restore`.

## Дополнительные команды

| Команда | Действие |
| --- | --- |
| `node scripts/manage-tv-startup.js back-enable` | Включить возврат Back для установленного runtime |
| `node scripts/manage-tv-optimizations.js inspect` | Прочитать состояние рекламных переключателей и предзагрузки Assistant |
| `node scripts/manage-tv-optimizations.js apply` | Сохранить резервную копию и применить оптимизации рекламных переключателей и предзагрузки Assistant |
| `node scripts/manage-tv-optimizations.js restore` | Восстановить эти параметры |
| `node scripts/sync-tv-catalog.js` | Заменить локальный каталог предпросмотра данными своего ТВ; такой снимок предназначен для личного использования |

Исходники публикации проверены 267 тестами, IPK успешно собран официальным CLI 3.2.6. Проверки на ТВ описаны в [истории разработки](DEVELOPMENT.md); при подготовке публикации новых подключений к телевизору не выполнялось. Локальные снимки, журналы, резервные копии и каталоги `.build/` / `%TEMP%` не публикуются. [DESIGN.md](../DESIGN.md) сохраняет историю проектирования.
