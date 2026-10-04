import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:transfertplus/src/ui/widgets/common.dart';

void main() {
  Widget host(Loader<String> loader) => MaterialApp(home: Scaffold(body: loader));

  testWidgets('relit la valeur tant que le traitement se poursuit, puis s\'arrête', (tester) async {
    final values = ['refund_pending', 'refund_pending', 'refunded'];
    var calls = 0;
    await tester.pumpWidget(
      host(Loader<String>(load: () async => values[calls++], refreshWhile: (value) => value != 'refunded', refreshEvery: const Duration(seconds: 3), builder: (context, value, reload) => Text(value))),
    );
    await tester.pump();
    expect(find.text('refund_pending'), findsOneWidget);

    await tester.pump(const Duration(seconds: 3));
    await tester.pump();
    // Relecture silencieuse : la valeur reste affichée, sans indicateur de chargement.
    expect(find.byType(CircularProgressIndicator), findsNothing);
    expect(calls, 2);

    await tester.pump(const Duration(seconds: 3));
    await tester.pump();
    expect(find.text('refunded'), findsOneWidget);

    await tester.pump(const Duration(seconds: 30));
    expect(calls, 3);
  });

  testWidgets('une relecture en échec garde la valeur affichée et réessaie', (tester) async {
    var calls = 0;
    await tester.pumpWidget(
      host(
        Loader<String>(
          load: () async {
            calls += 1;
            if (calls == 2) throw StateError('réseau');
            return calls == 1 ? 'payout_pending' : 'completed';
          },
          refreshWhile: (value) => value == 'payout_pending',
          builder: (context, value, reload) => Text(value),
        ),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(seconds: 3));
    await tester.pump();
    expect(find.text('payout_pending'), findsOneWidget);

    await tester.pump(const Duration(seconds: 3));
    await tester.pump();
    expect(find.text('completed'), findsOneWidget);
  });

  testWidgets('sans refreshWhile, aucune relecture', (tester) async {
    var calls = 0;
    await tester.pumpWidget(
      host(
        Loader<String>(
          load: () async {
            calls += 1;
            return 'x';
          },
          builder: (context, value, reload) => Text(value),
        ),
      ),
    );
    await tester.pump(const Duration(minutes: 1));
    expect(calls, 1);
  });
}
