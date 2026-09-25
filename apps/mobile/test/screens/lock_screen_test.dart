import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:stura/screens/lock_screen.dart';

void main() {
  testWidgets('LockScreen renders logo + StuRaOS + Entsperren button',
      (tester) async {
    await tester.pumpWidget(const MaterialApp(home: LockScreen()));

    // Logo glyph + wordmark.
    expect(find.text('S'), findsOneWidget);
    expect(find.text('StuRaOS'), findsOneWidget);
    // Unlock affordance.
    expect(find.text('Entsperren'), findsOneWidget);
    expect(find.byType(ElevatedButton), findsOneWidget);
  });

  testWidgets('LockScreen calls onUnlock when the button is tapped',
      (tester) async {
    var unlocked = false;
    await tester.pumpWidget(
      MaterialApp(
        home: LockScreen(onUnlock: () => unlocked = true),
      ),
    );

    await tester.tap(find.text('Entsperren'));
    await tester.pumpAndSettle();

    expect(unlocked, isTrue);
  });
}
