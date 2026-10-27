# Иконка Saint Look

Владелец предоставил `Integrated halo hanger icon.png`; неизменённый исходник
сохранён рядом как `halo-hanger-source.png`. Используем эту иллюстрацию как
иконку приложения по запросу #40. Не перерисовываем знак и не меняем цвета.

SHA-256 исходника: `23a58497ecfdb4a5c4564e4006887b0ccdf97bd7fe6b2a9067e693fea9585a00`.

`../SaintLook/Assets.xcassets/AppIcon.appiconset/AppIcon.png` — RGB PNG 1024×1024
без альфа-канала, уменьшенный из исходных 1254×1254 фильтром Lanczos.
Скругление применяет iOS; в изображение оно не добавлялось.

Повторить экспорт (Python с Pillow):

```python
from PIL import Image

with Image.open("client-ios/Design/halo-hanger-source.png") as source:
    source.resize((1024, 1024), Image.Resampling.LANCZOS).save(
        "client-ios/SaintLook/Assets.xcassets/AppIcon.appiconset/AppIcon.png"
    )
```
