/// Lecture stricte des réponses JSON : une forme inattendue lève une
/// FormatException plutôt que de produire une valeur par défaut silencieuse.
typedef Json = Map<String, Object?>;

Json asObject(Object? value, [String context = 'objet']) {
  if (value is Map<String, Object?>) return value;
  throw FormatException('$context attendu');
}

List<Json> asObjectList(Object? value, [String context = 'liste']) {
  if (value is! List<Object?>) throw FormatException('$context attendue');
  return [for (final item in value) asObject(item, context)];
}

extension JsonRead on Json {
  String string(String key) {
    final value = this[key];
    if (value is String) return value;
    throw FormatException('champ texte attendu : $key');
  }

  String? optionalString(String key) {
    final value = this[key];
    if (value == null || value is String) return value as String?;
    throw FormatException('champ texte ou null attendu : $key');
  }

  int integer(String key) {
    final value = this[key];
    if (value is int) return value;
    throw FormatException('champ entier attendu : $key');
  }

  int? optionalInteger(String key) {
    final value = this[key];
    if (value == null || value is int) return value as int?;
    throw FormatException('champ entier ou null attendu : $key');
  }

  bool boolean(String key) {
    final value = this[key];
    if (value is bool) return value;
    throw FormatException('champ booléen attendu : $key');
  }

  DateTime dateTime(String key) => DateTime.parse(string(key));

  DateTime? optionalDateTime(String key) {
    final value = optionalString(key);
    return value == null ? null : DateTime.parse(value);
  }

  Json object(String key) => asObject(this[key], key);

  Json? optionalObject(String key) => this[key] == null ? null : asObject(this[key], key);

  List<Json> objects(String key) => asObjectList(this[key], key);

  T oneOf<T extends WireEnum>(String key, List<T> values) => wireValue(string(key), values);
}

/// Énumération dont chaque valeur porte sa représentation exacte dans l'API.
abstract interface class WireEnum {
  String get wire;
}

T wireValue<T extends WireEnum>(String value, List<T> values) {
  for (final candidate in values) {
    if (candidate.wire == value) return candidate;
  }
  throw FormatException('valeur inattendue : $value');
}
