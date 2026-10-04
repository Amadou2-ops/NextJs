import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:transfertplus/src/core/lock/app_lock.dart';

import 'support/fakes.dart';

void main() {
  test('verrouillé au démarrage ; reverrouillé après un passage prolongé en arrière-plan', () async {
    var now = DateTime(2026, 10, 4, 12);
    final authenticator = FakeAuthenticator();
    final lock = AppLock(authenticator, clock: () => now);
    expect(lock.locked, isTrue);
    expect(await lock.unlock(), isTrue);
    expect(lock.locked, isFalse);

    lock.didChangeAppLifecycleState(AppLifecycleState.inactive);
    expect(lock.obscured, isTrue);
    lock.didChangeAppLifecycleState(AppLifecycleState.paused);
    now = now.add(const Duration(seconds: 20));
    lock.didChangeAppLifecycleState(AppLifecycleState.resumed);
    expect(lock.locked, isFalse, reason: 'absence courte');
    expect(lock.obscured, isFalse);

    lock.didChangeAppLifecycleState(AppLifecycleState.paused);
    now = now.add(const Duration(minutes: 2));
    lock.didChangeAppLifecycleState(AppLifecycleState.resumed);
    expect(lock.locked, isTrue);

    authenticator.answer = false;
    expect(await lock.unlock(), isFalse);
    expect(lock.locked, isTrue);
    expect(await lock.confirm('Confirmez le transfert'), isFalse);
    expect(authenticator.reasons.last, 'Confirmez le transfert');
  });
}
