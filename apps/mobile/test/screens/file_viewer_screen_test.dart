// mobile/test/screens/file_viewer_screen_test.dart
//
// Wave 3c T3.1 (G-049) — pure-function tests for safeFilename().
//
// We don't drive the full _download() path here because that depends on
// getTemporaryDirectory() (a platform channel) and a Provider-supplied
// StuRaOSApiClient. The threat model — server-controlled filename
// escaping the temp dir — lives entirely in safeFilename(), so we test
// it directly via the @visibleForTesting export.
import 'package:flutter_test/flutter_test.dart';
import 'package:stura/screens/files/file_viewer_screen.dart';

void main() {
  group('safeFilename (G-049)', () {
    test('plain filename round-trips unchanged', () {
      expect(safeFilename('report.pdf'), equals('report.pdf'));
      expect(safeFilename('photo.jpeg'), equals('photo.jpeg'));
    });

    test('traversal segments are stripped via basename', () {
      // p.basename treats the trailing component as the name.
      expect(safeFilename('../../../etc/passwd'), equals('passwd'));
      expect(safeFilename('subdir/foo.txt'), equals('foo.txt'));
    });

    test('null bytes and control chars are stripped', () {
      expect(safeFilename('foo\x00.txt'), equals('foo.txt'));
      expect(safeFilename('bar\x07baz.bin'), equals('barbaz.bin'));
      expect(safeFilename('\x01\x02report.pdf'), equals('report.pdf'));
    });

    test('pure `..` and `.` and empty become `untitled`', () {
      expect(safeFilename('..'), equals('untitled'));
      expect(safeFilename('.'), equals('untitled'));
      expect(safeFilename(''), equals('untitled'));
    });

    test('`..foo` is kept (only literal `..` is rejected)', () {
      // Legitimate name starting with two dots — basename returns it unchanged
      // and our rejection list only catches the exact strings '.', '..', ''.
      expect(safeFilename('..foo'), equals('..foo'));
    });

    test('overlength name is truncated, extension preserved', () {
      final long = '${'a' * 300}.txt';
      final out = safeFilename(long);
      expect(out.length, lessThanOrEqualTo(200));
      expect(out.endsWith('.txt'), isTrue);
    });

    test('overlength name with no extension is hard-capped', () {
      final out = safeFilename('a' * 500);
      expect(out.length, equals(200));
    });

    test('Windows-style separators do NOT split on POSIX path.basename', () {
      // p.basename uses the host OS separator; on POSIX hosts a literal
      // backslash is part of the filename. The null-byte + length checks
      // still apply, and our containment guard in _download() (parent ==
      // tempDir) catches anything that slipped through.
      const raw = r'..\..\foo.txt';
      final out = safeFilename(raw);
      // We deliberately don't assert exact equality (it varies by OS); we
      // only assert it's non-empty and doesn't contain a null byte.
      expect(out, isNotEmpty);
      expect(out.contains('\x00'), isFalse);
    });
  });
}
