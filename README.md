# YaEduSolver

Расширение для Chrome: показывает правильные ответы ЕГЭ и автоматически решает занятия на **education.yandex.ru** (Яндекс Учебник).

## Как

Перехватывает данные страницы и отправляет ответы теми же запросами, что и сам сайт. Всё управление — в окне расширения, на страницу ничего не добавляется.

## Установка

Через git:

```bash
git clone https://github.com/TishkaPon/YaEduSolver.git
```

Если git не установлен — скачай архив и распакуй:

```bash
curl -L https://github.com/TishkaPon/YaEduSolver/archive/refs/heads/main.zip -o YaEduSolver.zip
unzip YaEduSolver.zip
```

Либо просто **Code → Download ZIP** на странице репозитория.

Дальше одинаково: открой `chrome://extensions`, включи **Режим разработчика** и нажми **«Загрузить распакованное расширение»** — выбери папку с `manifest.json` (`YaEduSolver` после клонирования или `YaEduSolver-main` после распаковки).

Нужен **Chrome 111+** (Manifest V3).

## Дисклеймер

Неофициальный учебный проект. Использование может противоречить правилам сервиса — на свой риск.

## Лицензия

MIT.
