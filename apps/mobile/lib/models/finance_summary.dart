// mobile/lib/models/finance_summary.dart
//
// Dashboard finance KPI aggregate for the v4 HOME screen (slice 9).
// Mirrors the GET /api/finance/summary response: pending-approval count plus
// the active budget plan collapsed into total/free/spent (integer euro-cents).
class BudgetSummary {
  final int totalCents;
  final int freeCents;
  final int spentCents;

  const BudgetSummary({
    required this.totalCents,
    required this.freeCents,
    required this.spentCents,
  });

  factory BudgetSummary.fromJson(Map<String, dynamic> j) => BudgetSummary(
        totalCents: (j['totalCents'] as num?)?.toInt() ?? 0,
        freeCents: (j['freeCents'] as num?)?.toInt() ?? 0,
        spentCents: (j['spentCents'] as num?)?.toInt() ?? 0,
      );
}

class FinanceSummary {
  final int pendingApprovals;

  /// null when no budget plan exists.
  final BudgetSummary? budget;

  const FinanceSummary({required this.pendingApprovals, this.budget});

  factory FinanceSummary.fromJson(Map<String, dynamic> j) => FinanceSummary(
        pendingApprovals: (j['pendingApprovals'] as num?)?.toInt() ?? 0,
        budget: j['budget'] == null
            ? null
            : BudgetSummary.fromJson(j['budget'] as Map<String, dynamic>),
      );
}
