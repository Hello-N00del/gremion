// mobile/lib/widgets/role_guard.dart
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../models/user_session.dart';
import '../services/auth_service.dart';

class RoleGuard extends StatelessWidget {
  const RoleGuard(
      {required this.minRole, required this.child, this.fallback, super.key});
  final StuRaRole minRole;
  final Widget child;
  final Widget? fallback;

  @override
  Widget build(BuildContext context) {
    final session = context.watch<AuthService>().session;
    if (session == null || session.role.index < minRole.index) {
      return fallback ?? const SizedBox.shrink();
    }
    return child;
  }
}
