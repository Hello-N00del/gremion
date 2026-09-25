import 'package:flutter/material.dart';
import '../tokens/app_tokens.dart';

class FileLockBadge extends StatelessWidget {
  const FileLockBadge({super.key});
  @override
  Widget build(BuildContext context) => Tooltip(
        message: 'Edit on desktop only',
        child: Icon(Icons.lock_outline,
            size: 14, color: AppColors.of(context).warning),
      );
}
