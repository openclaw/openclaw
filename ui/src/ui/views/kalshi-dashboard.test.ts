/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderKalshiDashboard, type KalshiDashboardProps } from "./kalshi-dashboard.ts";

function createProps(overrides: Partial<KalshiDashboardProps> = {}): KalshiDashboardProps {
  return {
    loading: false,
    error: null,
    lastFetchAt: 0,
    timezone: "America/New_York",
    timeframe: "24h",
    pnlTimeframe: "all",
    strategySort: "problem_first",
    showDeepAudit: true,
    auditTablePages: {},
    auditTableQueries: {},
    onTimezoneChange: () => undefined,
    onTimeframeChange: () => undefined,
    onPnlTimeframeChange: () => undefined,
    onStrategySortChange: () => undefined,
    onToggleDeepAudit: () => undefined,
    onAuditTablePageChange: () => undefined,
    onAuditTableQueryChange: () => undefined,
    onRefresh: () => undefined,
    snapshot: {
      generated_at_utc: "2026-05-03T00:08:00Z",
      live_order_allowed: false,
      auto_apply_allowed: false,
      dashboard_refresh: {
        in_progress: false,
        stale: false,
        age_ms: 12_000,
        last_error: null,
      },
      paper: {
        total_decisions: 120,
        accepted: 6,
        exploration: 4,
        forward_paper: 2,
        rejected: 2,
        no_trade: 118,
      },
      paper_trade_accelerator: {
        route_mix: {
          overall: {
            SHADOW_ONLY: 14,
            ACCEPT_EXPLORATION: 2,
            ACCEPT_PAPER: 3,
            FORWARD_PAPER: 1,
          },
          weather_crypto: {
            ACCEPT_EXPLORATION: 2,
            FORWARD_PAPER: 1,
            ACCEPT_PAPER: 3,
            SHADOW_ONLY: 14,
          },
        },
        route_mix_total: {
          overall: {
            SHADOW_ONLY: 0.7,
            ACCEPT_EXPLORATION: 0.1,
            ACCEPT_PAPER: 0.15,
            FORWARD_PAPER: 0.05,
          },
          weather_crypto: {
            SHADOW_ONLY: 0.72,
            ACCEPT_EXPLORATION: 0.11,
            ACCEPT_PAPER: 0.13,
            FORWARD_PAPER: 0.04,
          },
        },
      },
      supreme_trading_strategy: {
        ok: true,
        schema_version: "sts-v1",
        generated_at_utc: "2026-05-03T00:08:00Z",
        mode: "PAPER_ONLY",
        status: "degraded",
        confidence_score: 0.62,
        current_regime: {
          label: "stale_source",
          confidence_score: 0.65,
          drivers: ["Outcome resolver is hitting market fetch failures."],
          live_order_allowed: false,
        },
        objective_scores: {
          accuracy: 0.85,
          calibration: 0.72,
          profitability: 0,
          learning_speed: 0.66,
          robustness: 1,
          statistical_validity: 1,
        },
        strategy_weights: [
          {
            strategy_id: "market_implied_baseline",
            domain: "all",
            regime_label: "stale_source",
            weight: 0.78,
            train_rows: 4480,
            test_rows: 1921,
            reason: "Market baseline retained.",
            live_order_allowed: false,
          },
          {
            strategy_id: "no_trade_baseline",
            domain: "all",
            regime_label: "stale_source",
            weight: 0.16,
            reason: "No-trade weight stays elevated.",
            live_order_allowed: false,
          },
        ],
        top_rationales: [
          {
            title: "Market baseline remains the champion",
            evidence: "Weather/Crypto rows: 6401.",
            impact: "STS weights market-implied probability highest.",
            live_order_allowed: false,
          },
        ],
        risk: {
          primary_blocker: "outcome_fetch_gap",
          live_order_allowed: false,
        },
        performance: { champion_status: "market_champion_retained" },
        learning: {
          weather_crypto_dataset_rows: 6401,
          sts_feature_rows: 6401,
          telemetry_snapshot_count: 80,
          markov_coverage_status: "ready_for_uplift_validation",
          domain_learning_acceleration: {
            enabled: true,
            weather_crypto_boost: 1.14,
            weather_crypto_raw_boost: 1.22,
            learning_velocity_multiplier: 1.09,
            weather_boost: 1.12,
            crypto_boost: 1.11,
            weather_crypto_decay_factor_weather: 0.91,
            weather_crypto_decay_factor_crypto: 0.83,
            weather_crypto_recent_edge_weather: 0.31,
            weather_crypto_recent_edge_crypto: 0.19,
            weather_crypto_decay_factor: 0.88,
            weather_crypto_recent_edge: 0.26,
            weather_crypto_stochastic_process_multiplier: 1.03,
            weather_crypto_stochastic_process_reason:
              "Stochastic diagnostics are currently improving route confidence.",
            weather_crypto_walk_forward_stability_multiplier: 0.97,
            weather_crypto_walk_forward_stability_reason:
              "Walk-forward stability is currently neutral-to-positive and keeps routing pressure largely intact.",
            stochastic_decay_reason: "Recent edge decayed from 0.35 to 0.26; applying decay guard.",
            weather_crypto_regime_decay_weather: {
              dry_front: {
                decay_factor: 0.81,
                late_edge: 0.17,
                reason: "Dry front backtest edge rolled over.",
              },
            },
            weather_crypto_regime_decay_crypto: {
              spike_reversal: {
                decay_factor: 0.73,
                late_edge: 0.12,
                reason: "Crypto regime edge decayed over latest buckets.",
              },
            },
            weather_crypto_reason:
              "Weather strength 26.0% · Crypto strength 24.0%; route weight is boosted when recent backtest rows remain clearly predictive.",
            sports_blocked: true,
            weather_crypto_sports_row_multiplier: 0,
            sports_reason: "Sports stays blocked until dedicated out-of-sample evidence exists.",
          },
          stochastic_process_policy: {
            coverage_status: "collecting",
            status: "neutral_collecting",
          },
        },
        model_health: { observability_status: "degraded" },
        data_health: { market_telemetry_ok: true },
        next_action:
          "Repair outcome fetch coverage so STS can learn faster from resolved paper labels.",
        live_order_allowed: false,
        auto_live_promotion_allowed: false,
      },
      self_improvement: {
        metrics: {
          brier_score: null,
          missing_outcome_rate: 1,
          scored_decisions: 3,
          exploration_paper_decisions: 4,
          forward_paper_decisions: 2,
          realized_paper_pnl_all_time_usd: 1.25,
          realized_paper_pnl_last_24h_usd: 0.75,
          realized_paper_pnl_last_7d_usd: 1.25,
          paper_performance_by_timeframe: {
            all: {
              label: "All time",
              scored_decisions: 3,
              wins: 2,
              losses: 1,
              accuracy: 0.667,
              net_pnl_usd: 1.25,
              total_profit_usd: 2.0,
              total_loss_usd: 0.75,
              category_accuracy: [
                {
                  category: "weather",
                  label: "Weather",
                  scored: 2,
                  wins: 2,
                  losses: 0,
                  accuracy: 1,
                  net_pnl_usd: 2.0,
                  total_profit_usd: 2.0,
                  total_loss_usd: 0,
                },
                {
                  category: "sports",
                  label: "Sports",
                  scored: 1,
                  wins: 0,
                  losses: 1,
                  accuracy: 0,
                  net_pnl_usd: -0.75,
                  total_profit_usd: 0,
                  total_loss_usd: 0.75,
                },
              ],
            },
            "6h": {
              label: "6 hours",
              scored_decisions: 1,
              wins: 1,
              losses: 0,
              accuracy: 1,
              net_pnl_usd: 1.25,
              total_profit_usd: 1.25,
              total_loss_usd: 0,
              category_accuracy: [
                {
                  category: "weather",
                  label: "Weather",
                  scored: 1,
                  wins: 1,
                  losses: 0,
                  accuracy: 1,
                  net_pnl_usd: 1.25,
                  total_profit_usd: 1.25,
                  total_loss_usd: 0,
                },
              ],
            },
            "1h": {
              label: "1 hour",
              scored_decisions: 0,
              wins: 0,
              losses: 0,
              accuracy: null,
              net_pnl_usd: 0,
              total_profit_usd: 0,
              total_loss_usd: 0,
              category_accuracy: [],
            },
          },
          paper_activity_by_timeframe: {
            "1h": {
              label: "1 hour",
              decisions: 12,
              accepted: 2,
              rejected: 4,
              no_trade: 6,
              outcomes_recorded: 0,
              scored_accepted: 0,
              latest_scored_outcome_utc: null,
            },
          },
          average_pnl_per_scored_trade_usd: 0.42,
          accuracy: 0.667,
          accuracy_last_24h: 1,
          accuracy_last_7d: 0.667,
          accuracy_wins: 2,
          accuracy_sample_size: 3,
          scored_directional_decisions: 3,
          scored_decisions_last_1h: 0,
          scored_decisions_last_6h: 1,
          scored_decisions_last_24h: 3,
          latest_scored_outcome_utc: "2026-05-03T20:00:00Z",
          unresolved_paper_exposure_usd: 8,
          fair_value_source_performance: {
            manual_input: { decisions: 6, scored: 3 },
          },
        },
      },
      learning_velocity: {
        status: "HIGH_SPEED_LEARNING",
        resolved_last_1h: 12,
        shadow_resolved_last_1h: 6,
        live_order_allowed: false,
      },
      strategy_scorecard: {
        scorecard_id: "fixture-scorecard",
        summary: {
          scored_accepted_decisions: 3,
          accuracy: 0.667,
          realized_pnl_usd: 1.25,
          paused_segments: 1,
          forward_paper_candidates: 0,
          live_review_candidates: 0,
        },
        trend: {
          x_axis: "Scored accepted paper trades over time",
          y_axis_left: "Accuracy",
          y_axis_right: "Cumulative paper P&L USD",
          points: [
            {
              index: 1,
              timestamp_utc: "2026-05-03T00:01:00Z",
              accuracy: 1,
              cumulative_pnl_usd: 1.25,
              latest_trade_pnl_usd: 1.25,
            },
            {
              index: 2,
              timestamp_utc: "2026-05-03T00:02:00Z",
              accuracy: 0.75,
              cumulative_pnl_usd: 0.5,
              latest_trade_pnl_usd: -0.75,
            },
            {
              index: 3,
              timestamp_utc: "2026-05-03T00:03:00Z",
              accuracy: 0.667,
              cumulative_pnl_usd: 0.1,
              latest_trade_pnl_usd: -0.4,
            },
            {
              index: 4,
              timestamp_utc: "2026-05-03T00:04:00Z",
              accuracy: 0.5,
              cumulative_pnl_usd: -0.25,
              latest_trade_pnl_usd: -0.35,
            },
            {
              index: 5,
              timestamp_utc: "2026-05-03T00:05:00Z",
              accuracy: 0.6,
              cumulative_pnl_usd: 0.75,
              latest_trade_pnl_usd: 1,
            },
            {
              index: 6,
              timestamp_utc: "2026-05-03T00:06:00Z",
              accuracy: 0.667,
              cumulative_pnl_usd: 1.25,
              latest_trade_pnl_usd: 0.5,
            },
            {
              index: 7,
              timestamp_utc: "2026-05-03T00:07:00Z",
              accuracy: 0.714,
              cumulative_pnl_usd: 1.7,
              latest_trade_pnl_usd: 0.45,
            },
            {
              index: 8,
              timestamp_utc: "2026-05-03T00:08:00Z",
              accuracy: 0.75,
              cumulative_pnl_usd: 2.25,
              latest_trade_pnl_usd: 0.55,
            },
          ],
        },
        segments: [
          {
            segment: "weather|NEW YORK|temperature|weather_model",
            status: "paused",
            domain: "weather",
            allowed_application_scope: "same_domain",
            transferability: "domain_specific",
            scored: 30,
            wins: 3,
            win_rate: 0.1,
            simulated_pnl_usd: -12,
            brier_score: 0.5,
            market_baseline_brier_score: 0.25,
          },
        ],
        learning_map: {
          taxonomy_version: "2026-05-04",
          domain_performance: [
            {
              domain: "weather",
              decisions: 80,
              accepted: 6,
              scored: 3,
              wins: 2,
              win_rate: 0.667,
              simulated_pnl_usd: 1.25,
              brier_score: 0.21,
              transfer_blocked: 0,
            },
            {
              domain: "sports",
              decisions: 10,
              accepted: 1,
              scored: 0,
              wins: 0,
              win_rate: null,
              simulated_pnl_usd: 0,
              brier_score: null,
              transfer_blocked: 0,
            },
          ],
          transfer_safe_lessons: ["liquidity", "spread", "depth"],
          domain_only_lessons: ["weather_model_edge", "sports_market_edge"],
          exploration_allocation: {
            proven_same_domain_forward_paper: 0.7,
            promising_same_domain_exploration: 0.2,
            new_hypotheses: 0.1,
          },
          negative_transfer_warnings: ["weather-to-sports transfer is forbidden"],
        },
        lessons_learned: [
          {
            lesson_id: "lesson-1",
            type: "pause_or_tighten_lane",
            status: "paused",
            segment: "weather|NEW YORK|temperature|weather_model",
            segment_label: "Weather temperature using weather model",
            title: "Stop adding paper risk here until evidence improves",
            evidence: "30 resolved paper trades, 3 wins, win rate 10.0%, paper P&L $-12.00.",
            change:
              "Pause this paper lane or require stricter edge, better depth, and clearer timing before another accepted paper trade.",
            expected_effect:
              "Reduces repeated simulated losses and pushes learning budget toward lanes with better evidence.",
            metric_to_watch: "paper P&L, accuracy, Brier score, and resolved sample size",
            confidence: "medium",
            auto_apply_allowed: false,
            live_order_allowed: false,
          },
        ],
        improvement_summary: {
          plain_english:
            "OpenClaw learns from resolved paper trades only. Losing or poorly calibrated lanes are paused or tightened.",
          what_needs_to_happen_next: [
            "Resolve pending accepted paper trades so accuracy and P&L can update.",
            "Shift new paper budget away from paused losing lanes.",
          ],
          auto_apply_allowed: false,
          live_order_allowed: false,
        },
      },
      performance_summary: {
        trend_direction: "mixed",
        best_segment: {
          segment: "weather|BOSTON|temperature|weather_model",
          status: "learning",
          scored: 12,
          win_rate: 0.58,
          simulated_pnl_usd: 4,
        },
        worst_segment: {
          segment: "weather|NEW YORK|temperature|weather_model",
          status: "paused",
          scored: 30,
          win_rate: 0.1,
          simulated_pnl_usd: -12,
        },
      },
      data_quality: {
        generated_age_minutes: 0,
        latest_scheduled_age_minutes: 4,
        latest_weather_age_minutes: 5,
        stale: false,
        warnings: [],
      },
      milestone_countdown: {
        ok: true,
        generated_at_utc: "2026-05-03T00:08:00Z",
        plain_english: "Conservative paper milestones only; Waiting means no defensible ETA.",
        milestones: [
          {
            milestone_id: "proof",
            label: "Proof",
            status: "tracking",
            eta_seconds: 183_840,
            eta_label: "2d 3h 4m",
            completion_score: 4.6,
            criteria: [
              { label: "Count", score: 3, eta_label: "2d 3h 4m", live_order_allowed: false },
              { label: "Profit", score: 0, eta_label: "Waiting", live_order_allowed: false },
              { label: "Accuracy", score: 8, eta_label: "Waiting", live_order_allowed: false },
              { label: "Baseline", score: 10, eta_label: "0d 0h 0m", live_order_allowed: false },
            ],
            live_order_allowed: false,
            auto_live_promotion_allowed: false,
          },
          {
            milestone_id: "profit",
            label: "Profit",
            status: "waiting",
            eta_seconds: null,
            eta_label: "Waiting",
            completion_score: 5,
            criteria: [
              { label: "Profit", score: 0, eta_label: "Waiting", live_order_allowed: false },
              { label: "Accuracy", score: 10, eta_label: "0d 0h 0m", live_order_allowed: false },
              { label: "Count", score: 5, eta_label: "3d 0h 0m", live_order_allowed: false },
            ],
            live_order_allowed: false,
            auto_live_promotion_allowed: false,
          },
          {
            milestone_id: "weather",
            label: "Weather",
            status: "tracking",
            eta_seconds: 10_800,
            eta_label: "0d 3h 0m",
            completion_score: 7,
            criteria: [
              { label: "Source", score: 10, eta_label: "0d 0h 0m", live_order_allowed: false },
              { label: "Baseline", score: 7, eta_label: "Waiting", live_order_allowed: false },
              { label: "ML", score: 4, eta_label: "0d 3h 0m", live_order_allowed: false },
            ],
            live_order_allowed: false,
            auto_live_promotion_allowed: false,
          },
          {
            milestone_id: "crypto",
            label: "Crypto",
            status: "waiting",
            eta_seconds: null,
            eta_label: "Waiting",
            completion_score: 3.3,
            criteria: [
              { label: "Basis", score: 0, eta_label: "Waiting", live_order_allowed: false },
              { label: "ML", score: 10, eta_label: "0d 0h 0m", live_order_allowed: false },
              { label: "Baseline", score: 0, eta_label: "Waiting", live_order_allowed: false },
            ],
            live_order_allowed: false,
            auto_live_promotion_allowed: false,
          },
          {
            milestone_id: "review",
            label: "Review",
            status: "waiting",
            eta_seconds: null,
            eta_label: "Waiting",
            completion_score: 4,
            criteria: [
              { label: "Count", score: 2, eta_label: "2d 3h 4m", live_order_allowed: false },
              { label: "Profit", score: 0, eta_label: "Waiting", live_order_allowed: false },
              { label: "Safety", score: 10, eta_label: "0d 0h 0m", live_order_allowed: false },
            ],
            live_order_allowed: false,
            auto_live_promotion_allowed: false,
          },
        ],
        live_order_allowed: false,
        auto_live_promotion_allowed: false,
      },
      accelerator: {
        decision_quality: {
          total: 120,
          accepted: 6,
          exploration: 4,
          forward_paper: 2,
          no_trade: 118,
          rejected: 2,
          top_no_trade_or_rejection_reasons: { "not two-sided": 118 },
        },
        distance_to_live_readiness: {
          accepted_rate: 0,
          resolved_outcomes: 0,
          resolved_outcomes_needed: 30,
        },
        ranked_actions: [
          {
            rank: 1,
            priority: "critical",
            type: "increase_scoreable_paper_candidates",
            evidence: "0 accepted paper decisions out of 120 total.",
            implementation_hint: "Add independent fair-value lanes.",
          },
        ],
        scheduler: {
          scheduled_run_count: 12,
          weather_run_count: 4,
          latest_scheduled_ok: true,
          latest_weather_ok: true,
        },
        weather_lane: {
          latest_discovery_parsed: 14,
          latest_discovery_trade_ready: 8,
          latest_run_parsed: 0,
          latest_run_trade_ready: 0,
          weather_expansion: {
            registered_city_count: 31,
            covered_city_count: 3,
            covered_cities: ["NEW YORK", "BOSTON", "PHOENIX"],
            watchlist_cities_without_trade_ready_markets: ["SAN FRANCISCO", "DENVER"],
            unsupported_weather_series_cities: ["DETROIT"],
            market_type_coverage: { high_temperature: 8 },
            discovery_approach: ["Kalshi Climate and Weather series-first discovery"],
            recommended_cities: [
              {
                city: "SAN FRANCISCO",
                station: "KSFO",
                weather_regime: "pacific_marine",
                score: 75,
                existing_trade_ready_markets: 0,
              },
            ],
          },
        },
      },
      paper_volume_accelerator: {
        metrics: {
          total_decisions: 120,
          accepted_decisions: 6,
          exploration_decisions: 4,
          resolved_outcomes: 3,
          outcome_backlog: 3,
          pending_resolution_buckets: { due_6h: 2, long_dated: 1 },
          pending_fast_resolution_count: 2,
          pending_slow_or_unknown_count: 1,
          unknown_timing_pending_count: 0,
          accepted_rate: 0.05,
          resolved_rate: 0.5,
          accepted_to_resolved_conversion_rate: 0.5,
          resolved_accepted_outcomes_per_day: 3,
          latest_scored_outcome_age_minutes: 42,
          current_learning_bottleneck: "low_resolution_rate",
          what_must_happen_next_to_learn_faster:
            "Run outcome scoring before expanding long-horizon paper exposure.",
          estimated_cycles_to_100_accepted: 19,
        },
        recommended_cycle_settings: {
          focused_watchlist: true,
          observe_limit: 30,
          max_orderbooks: 15,
          max_watchlist_markets: 35,
          max_auto_candidates: 18,
          resolution_priority: "high",
        },
        recommended_allocation: {
          weather_and_objective_fast_resolution: 0.5,
          high_liquidity_market_making_simulation: 0.2,
          historical_replay_research: 0.2,
          new_hypotheses: 0.1,
        },
        rapid_learning_plan: {
          mode: "PAPER_ONLY",
          objective: "maximize_scoreable_paper_evidence_per_cycle_without_live_trading",
          speed_mode_enabled: true,
          primary_bottleneck: "low_resolution_rate",
          bottlenecks: [
            {
              type: "low_resolution_rate",
              severity: "high",
              evidence: "Only 50.0% of accepted paper trades have resolved.",
              fix: "Run outcome scoring before expanding long-horizon paper exposure.",
            },
          ],
          next_cycle_profile: {
            observe_limit: 30,
            max_orderbooks: 15,
            max_watchlist_markets: 35,
            max_auto_candidates: 18,
            require_fast_resolution: true,
            max_hours_to_resolution: 24,
            allow_unknown_resolution: false,
            paper_exploration_enabled: true,
            max_exploration_size_usd: 2,
            resolution_priority: "high",
          },
          evidence_targets: {
            accepted_paper_trades_per_cycle: 5,
            minimum_resolved_outcomes: 30,
            minimum_domains_with_scoreable_candidates: 2,
            prefer_resolution_within_hours: 24,
            historical_replay_required: true,
          },
          read_efficiency: {
            use_batch_orderbooks: true,
            batch_orderbook_limit_tickers: 100,
            use_batch_candlesticks_for_historical_replay: true,
            avoid_blind_polling: true,
          },
          domain_targets: [
            {
              domain: "weather",
              current_decision_count: 80,
              target: "maintain_or_score",
              rule: "Use only independent non-LLM fair values and keep lessons domain-scoped.",
            },
            {
              domain: "sports",
              current_decision_count: 0,
              target: "expand_scoreable_lane",
              rule: "Use only independent non-LLM fair values and keep lessons domain-scoped.",
            },
          ],
          proof_rules: {
            exploration_counts_as_learning_not_live_proof: true,
            forward_paper_required_for_live_review: true,
            category_lessons_transfer_across_domains: false,
            live_order_allowed: false,
            auto_apply_to_live_allowed: false,
          },
        },
        ranked_actions: [
          {
            rank: 1,
            priority: "high",
            type: "convert_pending_paper_trades_to_scored_evidence",
            evidence: "3 accepted paper trades are unresolved.",
            implementation_hint:
              "Schedule outcome checks before expanding long-horizon candidate volume.",
            live_order_allowed: false,
            auto_apply_allowed: false,
          },
        ],
      },
      weather_model_audit: {
        weather_decisions: 12,
        scored_weather_decisions: 6,
        unresolved_weather_decisions: 6,
        failure_modes: { high_confidence_weather_miss: 4, edge_too_thin_after_costs: 2 },
        primary_action: {
          type: "tighten_or_pause_weather_bucket",
          priority: "high",
          recommendation:
            "Tighten this weather bucket before accepting more rapid-learning paper trades.",
          live_order_allowed: false,
          auto_apply_allowed: false,
        },
        bucket_summaries: [
          {
            city: "CHICAGO",
            market_type: "high_temperature",
            scored: 6,
            win_rate: 0.333333,
            simulated_pnl_usd: -5.25,
            failure_modes: { high_confidence_weather_miss: 4 },
            action: {
              recommendation:
                "Tighten this weather bucket before accepting more rapid-learning paper trades.",
            },
          },
        ],
        plain_english:
          "Tighten this weather bucket before accepting more rapid-learning paper trades.",
      },
      shadow_discovery: {
        metrics: {
          shadow_trades: 9,
          scored_shadow_trades: 6,
          newly_scored_shadow_trades: 2,
          unresolved_shadow_trades: 3,
          directional_scored_shadow_trades: 4,
          shadow_wins: 3,
          shadow_win_rate: 0.75,
          shadow_hypothetical_pnl_usd: 1.25,
          no_trade_baselines: 3,
        },
        by_action: [
          {
            action: "SHADOW_BUY_YES",
            scored: 3,
            directional_scored: 3,
            wins: 2,
            win_rate: 0.6667,
            hypothetical_pnl_usd: 0.75,
          },
          {
            action: "SHADOW_BUY_NO",
            scored: 1,
            directional_scored: 1,
            wins: 1,
            win_rate: 1,
            hypothetical_pnl_usd: 0.5,
          },
        ],
        best_segments: [
          {
            domain: "weather",
            market_category: "weather",
            shadow_action: "SHADOW_BUY_YES",
            directional_scored: 3,
            win_rate: 0.6667,
            hypothetical_pnl_usd: 0.75,
            eligible_for_exploration_review: true,
          },
        ],
        exploration_review_candidates: [
          {
            domain: "weather",
            shadow_action: "SHADOW_BUY_YES",
            directional_scored: 3,
            win_rate: 0.6667,
            hypothetical_pnl_usd: 0.75,
            eligible_for_exploration_review: true,
          },
        ],
        plain_english: "Shadow discovery scores hypothetical trades OpenClaw did not accept.",
        live_order_allowed: false,
        auto_apply_allowed: false,
      },
      inverse_strategy_audit: {
        metrics: {
          total_directional_scored: 126,
          original_accuracy: 0.0952,
          inverse_accuracy: 0.9048,
          accuracy_delta_inverse_minus_original: 0.8095,
          original_pnl_usd: -201.8,
          inverse_pnl_usd: 133.1,
          pnl_delta_inverse_minus_original_usd: 334.9,
          executable_quality_trades: 24,
          executable_quality_fraction: 0.1905,
          synthetic_or_unpriced_trades: 102,
          contrarian_forward_paper_candidates: [],
          best_segments: [
            {
              domain: "weather",
              scored: 61,
              original_win_rate: 0.0492,
              inverse_win_rate: 0.9508,
              original_pnl_usd: -42.1,
              inverse_pnl_usd: 34.6,
              inverse_minus_original_pnl_usd: 76.7,
              executable_quality_fraction: 0.1311,
              contrarian_forward_paper_candidate: false,
              live_order_allowed: false,
              auto_apply_allowed: false,
            },
          ],
        },
        recommendations: [
          {
            type: "test_inverse_strategy_forward_paper",
            status: "REVIEW_REQUIRED",
            evidence:
              "Inverse Standard Strategy audit accuracy 90.5% vs Standard Strategy 9.5%; P&L delta +334.90 USD.",
            proposed_change:
              "Create bounded forward-paper candidates for qualifying Inverse Standard Strategy segments only.",
            auto_apply_allowed: false,
            live_order_allowed: false,
          },
        ],
        plain_english:
          "This audit tests the exact question: would the opposite side of resolved directional paper trades have performed better?",
        live_order_allowed: false,
        auto_apply_allowed: false,
      },
      strategy_comparison: {
        ok: true,
        scope: "paper_only_current_epoch",
        primary_metric_source: "actual_accepted_paper_trades",
        secondary_metric_source: "historical_inverse_audit",
        actual_summary: {
          standard_accuracy: 0.4,
          inverse_standard_accuracy: 0.7,
          accuracy_delta_inverse_minus_standard: 0.3,
          standard_pnl_usd: -10.0,
          inverse_standard_pnl_usd: 12.5,
          pnl_delta_inverse_minus_standard_usd: 22.5,
          standard_scored: 10,
          inverse_standard_scored: 10,
          live_order_allowed: false,
        },
        audit_summary: {
          standard_accuracy: 0.0952,
          inverse_standard_accuracy: 0.9048,
          accuracy_delta_inverse_minus_standard: 0.8095,
          standard_pnl_usd: -201.8,
          inverse_standard_pnl_usd: 133.1,
          pnl_delta_inverse_minus_standard_usd: 334.9,
          scored: 126,
          executable_quality_fraction: 0.1905,
          synthetic_or_unpriced_trades: 102,
          live_order_allowed: false,
        },
        plain_english:
          "This section now uses actual accepted paper trades as the primary numbers. The historical inverse audit remains visible as supporting evidence, but it is not counted as actual Inverse Standard Strategy performance.",
        rows: [
          {
            strategy_id: "standard_strategy",
            display_name: "Standard Strategy",
            role: "Standard Strategy baseline kept for comparison.",
            decisions: 24,
            accepted: 20,
            shadow_decisions: 4,
            scored: 10,
            accuracy: 0.4,
            paper_pnl_usd: -10.0,
            average_pnl_per_scored_trade_usd: -1.0,
            unresolved: 10,
            domains: { weather: 12, sports: 8, crypto: 4 },
            audit_accuracy: 0.0952,
            audit_pnl_usd: -201.8,
            tracking_status: "baseline",
            next_step: "Use as the control group.",
            live_order_allowed: false,
          },
          {
            strategy_id: "inverse_standard_strategy",
            display_name: "Inverse Standard Strategy",
            role: "Active Inverse Standard Strategy paper strategy.",
            decisions: 18,
            accepted: 12,
            shadow_decisions: 6,
            scored: 10,
            accuracy: 0.7,
            paper_pnl_usd: 12.5,
            average_pnl_per_scored_trade_usd: 1.25,
            unresolved: 2,
            domains: { weather: 18 },
            audit_accuracy: 0.9048,
            audit_pnl_usd: 133.1,
            tracking_status: "tracking",
            next_step: "Keep proving executable forward-paper quality.",
            live_order_allowed: false,
          },
          {
            strategy_id: "weather_arbitrage_strategy",
            display_name: "Weather Arbitrage Strategy",
            role: "Paper-only weather arbitrage lane.",
            decisions: 0,
            accepted: 0,
            shadow_decisions: 0,
            scored: 0,
            accuracy: null,
            paper_pnl_usd: 0,
            average_pnl_per_scored_trade_usd: null,
            unresolved: 0,
            domains: {},
            tracking_status: "waiting_for_weather_arbitrage_scanner",
            next_step: "Build bucket-level weather arbitrage scanner.",
            live_order_allowed: false,
          },
          {
            strategy_id: "polyclaw",
            display_name: "PolyClaw",
            role: "PolyClaw skill lane.",
            decisions: 0,
            accepted: 0,
            shadow_decisions: 0,
            scored: 0,
            accuracy: null,
            paper_pnl_usd: 0,
            average_pnl_per_scored_trade_usd: null,
            unresolved: 0,
            domains: {},
            tracking_status: "waiting_for_polyclaw_skill_data",
            next_step: "Run PolyClaw in paper-only mode.",
            live_order_allowed: false,
          },
          {
            strategy_id: "polymarket_kalshi_divergence",
            display_name: "polymarket-kalshi-divergence",
            role: "Polymarket/Kalshi divergence skill lane.",
            decisions: 0,
            accepted: 0,
            shadow_decisions: 0,
            scored: 0,
            accuracy: null,
            paper_pnl_usd: 0,
            average_pnl_per_scored_trade_usd: null,
            unresolved: 0,
            domains: {},
            tracking_status: "waiting_for_polymarket_kalshi_divergence_skill_data",
            next_step: "Run the polymarket-kalshi-divergence skill in paper-only mode.",
            live_order_allowed: false,
          },
          {
            strategy_id: "strategy_bucket:source_lag_surface",
            display_name: "Source Lag Surface",
            role: "Named weather/crypto source-lag strategy lane.",
            decisions: 9,
            accepted: 3,
            shadow_decisions: 6,
            scored: 2,
            accuracy: 0.5,
            paper_pnl_usd: -4.5,
            average_pnl_per_scored_trade_usd: -2.25,
            unresolved: 1,
            domains: { weather: 6, crypto: 3 },
            tracking_status: "tracking",
            next_step: "Keep source-backed weather/crypto hypotheses paper-only.",
            live_order_allowed: false,
          },
        ],
        live_order_allowed: false,
        auto_live_promotion_allowed: false,
      },
      opportunity_engine: {
        metrics: {
          opportunities_detected: 2,
          experiments_created: 1,
          possible_bug: 1,
          low_quality_data: 0,
          live_order_allowed: false,
          auto_live_promotion_allowed: false,
        },
        opportunities: [
          {
            opportunity_id: "opp-1",
            detector: "inverse_detector",
            diagnosis: "likely_edge",
            status: "in_forward_paper",
            domain: "weather",
            evidence: "Inverse Standard Strategy side beat Standard Strategy weather segment.",
            next_paper_action: "Create a segment-scoped inverse forward-paper experiment.",
            live_order_allowed: false,
            auto_live_promotion_allowed: false,
          },
          {
            opportunity_id: "opp-2",
            detector: "data_quality_detector",
            diagnosis: "possible_bug",
            status: "bug_review_required",
            domain: "weather",
            evidence: "Weather parser direction needs review.",
            next_paper_action: "Review parser before creating new paper risk.",
            live_order_allowed: false,
            auto_live_promotion_allowed: false,
          },
        ],
        experiments: [
          {
            experiment_id: "opp-exp-1",
            opportunity_id: "opp-1",
            detector: "inverse_detector",
            domain: "weather",
            experiment_type: "bounded_forward_paper",
            paper_notional_usd: 1,
            status: "active",
            live_order_allowed: false,
            auto_live_promotion_allowed: false,
          },
        ],
        diagnostics: {
          plain_english: "The opportunity engine searches for hidden paper-strategy improvements.",
        },
        live_order_allowed: false,
        auto_live_promotion_allowed: false,
        paper_auto_apply_allowed: true,
      },
      strategy_governor: {
        routed_count: 42,
        action_counts: {
          INVERSE_FORWARD_TEST: 3,
          PAUSE_SEGMENT: 2,
          REJECT_DATA_QUALITY: 7,
          SHADOW_ONLY: 30,
        },
        accepted_or_tested_count: 3,
        shadow_or_blocked_count: 39,
        inverse_forward_tests: 3,
        plain_english:
          "The strategy governor routes each paper candidate through clean-evidence, inverse-signal, segment-health, and firewall checks.",
        latest_change: {
          governor_action: "INVERSE_FORWARD_TEST",
          plain_language_reason:
            "Inverse signal passed clean evidence checks for weather temperature only.",
          segment_scope: "leaf|weather|temperature|high_temperature|inverse_probe",
          rollback_rule:
            "Stop inverse paper tests for this segment if forward-paper evidence worsens.",
          live_order_allowed: false,
          auto_live_promotion_allowed: false,
        },
        top_active_hypothesis: {
          governor_action: "INVERSE_FORWARD_TEST",
          domain: "weather",
          segment_scope: "weather temperature inverse probe",
          plain_language_reason:
            "Weather inverse buy-NO probe is being tested with tiny paper notional.",
        },
        top_blocked_losing_lane: {
          governor_action: "PAUSE_SEGMENT",
          domain: "weather",
          segment_scope: "weather buy-YES high temperature",
          plain_language_reason:
            "This lane is blocked from accepted paper risk because resolved evidence is losing.",
        },
        live_order_allowed: false,
        auto_live_promotion_allowed: false,
      },
      live_readiness: {
        readiness: "BLOCKED",
        live_trading_enabled: false,
        live_order_allowed: false,
        blockers: ["not enough resolved paper outcomes"],
      },
      no_live_validator: { critical_failures: [] },
      top_action: {
        priority: "critical",
        type: "increase_scoreable_paper_candidates",
        evidence: "0 accepted paper decisions out of 120 total.",
        implementation_hint: "Add independent fair-value lanes.",
      },
      pending_paper_trades: {
        count: 2,
        shown: 2,
        total_unresolved_exposure_usd: 4,
        average_estimated_success_probability: 0.61,
        newest_timestamp_utc: "2026-05-03T00:10:00Z",
        trades: [
          {
            decision_id: "paper-1",
            timestamp_utc: "2026-05-03T20:10:00Z",
            market_ticker: "KXTEST-YES",
            market_title: "Will the test market resolve yes?",
            decision: "PAPER_EXPLORE_BUY_YES",
            side: "YES",
            bet_summary: "Paper buy YES on: Will the test market resolve yes?",
            win_condition:
              "To win, this market must resolve YES: Will the test market resolve yes?",
            evidence_tier: "exploration",
            strategy_bucket: "market_making_simulation",
            estimated_success_probability: 0.62,
            market_probability_at_entry: 0.54,
            fair_probability: 0.62,
            edge_after_costs_pct: 6.3,
            simulated_size_usd: 2,
            paper_fill_price_cents: 54,
            paper_profit_if_win_usd: 1.7,
            paper_loss_if_wrong_usd: -2,
            reason: "bounded paper exploration trade",
            expected_resolution_time_utc: "2026-05-04T21:30:00Z",
            resolution_time_source: "expected_expiration_time",
            resolution_time_source_label: "Kalshi expected expiration",
            resolution_timing_note:
              "Based on Kalshi expected expiration; actual settlement can post after Kalshi resolves the market.",
            settlement_timer_seconds: 300,
            expected_result_known_time_utc: "2026-05-04T21:35:00Z",
            result_known_time_source: "expected_resolution_plus_settlement_timer",
            result_known_time_source_label: "Kalshi timing plus settlement timer",
            result_known_timing_note:
              "Estimated from the best logged Kalshi timing field plus settlement_timer_seconds; actual posting can still be delayed by Kalshi settlement processing.",
          },
        ],
      },
      recent_paper_bets: {
        count: 2,
        shown: 2,
        resolved_in_shown: 1,
        pending_in_shown: 1,
        resolved_count: 1,
        latest_resolved_shown: 1,
        trades: [
          {
            decision_id: "paper-1",
            timestamp_utc: "2026-05-03T20:10:00Z",
            market_ticker: "KXTEST-YES",
            market_title: "Will the test market resolve yes?",
            decision: "PAPER_EXPLORE_BUY_YES",
            side: "YES",
            bet_summary: "Paper buy YES on: Will the test market resolve yes?",
            evidence_tier: "exploration",
            estimated_success_probability: 0.62,
            simulated_size_usd: 2,
            outcome_status: "resolved",
            outcome_yes: 1,
            paper_result: "win",
            paper_pnl_usd: 1.7,
            settlement_checked_at_utc: "2026-05-04T21:40:00Z",
            settlement_source: "kalshi_market_result_read",
            expected_resolution_time_utc: "2026-05-04T21:30:00Z",
            resolution_time_source: "expected_expiration_time",
            resolution_time_source_label: "Kalshi expected expiration",
            resolution_timing_note:
              "Based on Kalshi expected expiration; actual settlement can post after Kalshi resolves the market.",
            settlement_timer_seconds: 300,
            expected_result_known_time_utc: "2026-05-04T21:35:00Z",
            result_known_time_source: "expected_resolution_plus_settlement_timer",
            result_known_time_source_label: "Kalshi timing plus settlement timer",
            result_known_timing_note:
              "Estimated from the best logged Kalshi timing field plus settlement_timer_seconds; actual posting can still be delayed by Kalshi settlement processing.",
          },
        ],
        latest_resolved_trades: [
          {
            decision_id: "paper-1",
            timestamp_utc: "2026-05-03T20:10:00Z",
            market_ticker: "KXTEST-YES",
            market_title: "Will the test market resolve yes?",
            side: "YES",
            bet_summary: "Paper buy YES on: Will the test market resolve yes?",
            win_condition: "To win, this paper trade needs Kalshi to resolve the market YES.",
            outcome_status: "resolved",
            outcome_yes: 1,
            paper_result: "win",
            paper_pnl_usd: 1.7,
            settlement_checked_at_utc: "2026-05-04T21:40:00Z",
            settlement_source: "kalshi_market_result_read",
          },
        ],
      },
      crypto_evidence: {
        ok: true,
        timestamp_utc: "2026-05-03T00:07:00Z",
        active_crypto_markets_seen: 5,
        parseable_crypto_markets: 0,
        crypto_readiness_status: "check_due_now",
        next_crypto_trade_ready_check_time_utc: null,
        seconds_until_next_crypto_trade_ready_check: 0,
        next_crypto_trade_ready_unavailable_reason:
          "latest_crypto_trade_ready_check_time_already_due",
        last_crypto_trade_ready_check_time_utc: "2026-05-03T00:06:00Z",
        crypto_readiness_summary:
          "Latest crypto trade-ready check time (2026-05-03T00:06:00Z) has arrived; rerun crypto evidence now.",
        orderbooks_checked: 0,
        spot_assets_available: ["BTC", "ETH"],
        candidate_count: 0,
        created_count: 0,
        created_by_governor_action: { SHADOW_ONLY: 3 },
        plain_english_summary: "Crypto evidence lane ran without accepted live-trading authority.",
        warnings: [],
        live_order_allowed: false,
        auto_live_promotion_allowed: false,
      },
      markov_microstructure: {
        ok: true,
        status: "research_active",
        generated_at_utc: "2026-05-03T00:07:30Z",
        diagnostic_version: "markov-microstructure-research-v1",
        research_only: true,
        not_trade_signal: true,
        summary: {
          status: "research_active",
          analyzed_market_count: 2,
          universe_count: 2,
          low_data_market_count: 1,
          taker_trap_count: 1,
          tiny_paper_review_only_count: 0,
          observe_only_count: 1,
          pass_count: 1,
          best_confidence_score: 6,
          plain_english:
            "Probability diagnostics is live as a research/risk panel for weather and crypto.",
          next_action:
            "Use this panel to veto weak paper ideas; do not promote it into an execution signal.",
          live_order_allowed: false,
          auto_live_promotion_allowed: false,
        },
        study_reference: {
          title: "The Microstructure of Wealth Transfer in Prediction Markets",
          author: "Jonathan Becker",
          dataset_summary: "72.1M Kalshi trades / $18.26B notional.",
          live_order_allowed: false,
        },
        markets: [
          {
            market_ticker: "KXWEATHER-MARKOV",
            title: "Will the high temperature in Boston be above 70?",
            category: "weather",
            current_yes_price: 0.42,
            current_bucket: 4,
            raw_markov_yes_proxy: 0.55,
            becker_longshot_prior: 0.53,
            calibrated_probability: 0.542,
            market_price: 0.42,
            edge_vs_market_pct: 12.2,
            confidence_score: 6,
            confidence_caps: ["current_bucket_has_fewer_than_30_transitions"],
            routing_label: "OBSERVE_ONLY",
            sample: {
              history_points: 64,
              total_transitions: 63,
              current_row_transitions: 29,
              data_source: "kalshi_candlesticks",
            },
            transition_heatmap: {
              bucket_count: 10,
              current_bucket: 4,
              row_counts: [0, 0, 0, 5, 29, 12, 0, 0, 0, 0],
              matrix: Array.from({ length: 10 }, (_, row) =>
                Array.from({ length: 10 }, (_, column) =>
                  row === column ? 0.7 : column === row + 1 ? 0.3 : 0,
                ),
              ),
            },
            terminal_distribution: [0, 0, 0.05, 0.1, 0.3, 0.25, 0.2, 0.1, 0, 0],
            execution: {
              yes_maker_edge_pct: 8.2,
              yes_taker_edge_pct: -1.4,
              no_maker_edge_pct: -4.2,
              no_taker_edge_pct: -9.1,
              best_yes_ask_probability: 0.43,
              best_no_ask_probability: 0.59,
              estimated_yes_spread_cents: 2,
              depth_contracts: 240,
              fill_quality: "high",
              maker_taker_category_gap_pct: 2.57,
              maker_taker_warning:
                "Maker-first only; taker edge is penalized for Kalshi microstructure and spread/fee drag.",
            },
            warnings: ["low_transition_sample_current_bucket", "maker_preferred_over_taker"],
            research_only: true,
            not_trade_signal: true,
            live_order_allowed: false,
            auto_live_promotion_allowed: false,
          },
        ],
        calibration_tracking: {
          bucket_count: 1,
          plain_english:
            "Calibration tracking uses resolved paper outcomes by price bucket; low samples are warnings, not proof.",
          rows: [
            {
              category: "weather",
              bucket_label: "40-50¢",
              count: 8,
              wins: 4,
              actual_win_rate: 0.5,
              average_implied_probability: 0.45,
              actual_minus_implied_pct: 5,
              sample_quality: "low_sample",
              live_order_allowed: false,
            },
          ],
          live_order_allowed: false,
          auto_live_promotion_allowed: false,
        },
        warnings: [],
        live_order_allowed: false,
        auto_live_promotion_allowed: false,
      },
      log_counts: { market_observations: 25 },
    },
    ...overrides,
  };
}

describe("Kalshi dashboard view", () => {
  it("renders the STS command center above legacy strategy details", () => {
    const container = document.createElement("div");

    render(renderKalshiDashboard(createProps()), container);

    const text = container.textContent ?? "";
    expect(text).toContain("Supreme Trading Strategy");
    expect(text).toContain("STS is learning, but a data or proof gap is holding it back.");
    expect(text).toContain("Repair outcome fetch coverage so STS can learn faster");
    expect(text).toContain("Live trading is off");
    expect(text).toContain("market baseline");
    expect(text).toContain("W/C ML Weight");
    expect(text).toContain(
      "Weather/Crypto challenger is currently blocked by proof/quality checks.",
    );
    expect(text).toContain("Overall route mix");
    expect(text).toContain("Weather / Crypto route mix");
    expect(text).toContain("accept exploration");
    expect(text).toContain("Sports Routing");
    expect(text).toContain("Calibration");
    expect(text).toContain("Sports routing is intentionally held at zero in paper mode.");
    expect(text).toContain("ML Route Boost");
    expect(text).toContain("Route Multiplier (x)");
    expect(text).toContain("Learning Reallocation");
    expect(text).toContain("Stochastic Process Lift");
    expect(text).toContain("Sports Execution Reliability");
    expect(text).toContain("Sports Row Multiplier");
    expect(text).toContain("Walk-Forward Stability Lift");
    expect(text).toContain("Learning Velocity Boost");
    expect(text).toContain("Weather Decay");
    expect(text).toContain("Crypto Decay");
    expect(text).toContain("Stochastic Decay Guard");
    expect(text).toContain("Recent W/C Edge");
    expect(text).toContain("Weather Recent W/C Edge");
    expect(text).toContain("Crypto Recent W/C Edge");
    expect(text).toContain("Regime Decay Coverage");
    expect(text).toContain("Regime Lift Check");
    expect(text.indexOf("Supreme Trading Strategy")).toBeLessThan(text.indexOf("Strategy Cockpit"));
  });

  it("renders Today-first dashboard metrics with Advanced Audit available", () => {
    const container = document.createElement("div");

    render(renderKalshiDashboard(createProps()), container);

    const text = container.textContent ?? "";
    expect(text).toContain("Kalshi Paper Trading");
    expect(text).toContain("Live trading is off");
    expect(text).toContain("Here’s what matters.");
    expect(text).toContain("Safety");
    expect(text).toContain("Learning");
    expect(text).toContain("Profit proof");
    expect(text).toContain("Next");
    expect(text).toContain("What changed?");
    expect(text).toContain("Snapshot current");
    expect(text).toContain("12s old");
    expect(text).toContain("Learning lanes");
    expect(text).toContain("Routing gate you can test now");
    expect(text).toContain("Weather/Crypto ML Boost");
    expect(text).toContain("Calibration Gate");
    expect(text).toContain("Learning Reallocation");
    expect(text).toContain("Stochastic Process Lift");
    expect(text).toContain("Stochastic Guard");
    expect(text).toContain("Domain Route Boost");
    expect(text).toContain("Route Multiplier (x)");
    expect(text).toContain("Learning Velocity Boost");
    expect(text).toContain("Weather/Crypto is accelerator-guided.");
    expect(text).toContain("Weather Decay");
    expect(text).toContain("Crypto Decay");
    expect(text).toContain("Stochastic Decay Guard");
    expect(text).toContain("Weather");
    expect(text).toContain("Crypto");
    expect(text).toContain("Sports");
    expect(text).toContain("Sports remains practice-only until fresh proof beats the baselines.");
    expect(text).toContain("Sports Safety Hold");
    expect(text).toContain("Halted");
    expect(text).toContain("Weather/Crypto Boost");
    expect(text).toContain("Probability Diagnostics");
    expect(text).toContain("Markov and microstructure risk, not a trade signal.");
    expect(text).toContain("This module can veto weak ideas or mark them observe-only.");
    expect(text).toContain("KXWEATHER-MARKOV");
    expect(text).toContain("State-transition heatmap");
    expect(text).toContain("Research only");
    expect(text).toContain("Advanced Audit");
    expect(text).toContain("Hide Advanced Audit");
    expect(container.querySelector(".kalshi-hero--blocked")).not.toBeNull();
    expect(container.querySelector(".kalshi-live-pill--safe")).not.toBeNull();
    expect(container.querySelector(".kalshi-markov-heatmap__cell--current")).not.toBeNull();
    expect(container.querySelector('button[aria-label="Refresh Kalshi dashboard"]')).not.toBeNull();

    expect(text).toContain("Strategy Cockpit");
    expect(text).toContain("Every named strategy lane, one comparable table.");
    expect(text).toContain("Sort strategies");
    expect(text).toContain("6 named strategy lanes");
    expect(text).toContain("accepted paper");
    expect(text).toContain("shadow/control");
    expect(text).toContain("Accepted / Shadow");
    expect(text).toContain("Avg/trade");
    expect(text).toContain("Source Lag Surface");
    expect(text).toContain("Named weather/crypto source-lag strategy lane.");
    expect(text).toContain("Strategy Comparison Details");
    expect(text).toContain("Paper Learning Snapshot");
    expect(text).toContain("Paper profit/loss");
    expect(text).toContain("Category Accuracy");
    expect(text).toContain("Accuracy and paper profit/loss trend");
    expect(text).toContain("Paper Volume Accelerator");
    expect(text).toContain("Weather Model Audit");
    expect(text).toContain("Strategy Discovery");
    expect(text).toContain("Inverse Standard Strategy Audit");
    expect(text).toContain("Hidden Opportunities");
    expect(text).toContain("Strategy Governor");
    expect(text).toContain("Strategy Health");
    expect(text).toContain("Decision Quality");
    expect(text).toContain("Live-Readiness Funnel");
    expect(text).toContain("Crypto Readiness");
    expect(text).toContain("Check due now");
    expect(text).toContain("rerun crypto evidence now");
    expect(text).toContain("Weather Expansion");
    expect(text).toContain("Next 50 Upcoming Paper Trades To Resolve");
    expect(text).toContain("Recent Paper Bets");
    expect(text).toContain("Latest Resolved Paper Results");
    expect(text).toContain("KXTEST-YES");
    expect(text).toContain("kalshi_market_result_read");

    expect(text).toContain("Δ vs Standard");
    expect(text).toContain("+$22.50");
    expect(text).toContain("actual vs Standard");
    expect(text).toContain("baseline");
    expect(text).toContain("waiting for scored proof");
    expect(text).toContain("Weather Arbitrage Strategy");
    expect(text).toContain("PolyClaw");
    expect(text).toContain("polymarket-kalshi-divergence");
    expect(text).toContain("Build bucket-level weather arbitrage scanner");
    expect(text).toContain("The Strategy Cockpit above is now the primary comparison surface.");
    expect(text).toContain("No live orders can be enabled");
    expect(text).toContain("Weather temperature using weather model");
    expect(text).toContain("weather-to-sports transfer is forbidden");
    expect(text).toContain("SAN FRANCISCO");
    expect(text).toContain("Kalshi Climate and Weather series-first discovery");
    expect(text).toContain(
      "Expected Result Known uses logged Kalshi timing plus settlement timer data",
    );
    expect(text).toContain("Trade 8");
    expect(text).toContain("Paper profit/loss +$2.25");
    expect(text).toContain("Timeframe: 24 hours");

    expect(container.querySelector(".kalshi-trend-chart svg")).not.toBeNull();
    expect(container.querySelector(".kalshi-chart-now")).not.toBeNull();
    expect(container.querySelector(".kalshi-chart-projection-zone")).not.toBeNull();
    expect(container.querySelector(".kalshi-chart-line--projection")).not.toBeNull();
    expect(container.querySelector(".kalshi-chart-volume-bar")).not.toBeNull();
    expect(container.querySelector(".kalshi-chart-hover-column")).not.toBeNull();
    expect(container.querySelector(".kalshi-chart-tooltip")).not.toBeNull();
    expect(container.querySelector(".kalshi-chart-tooltip-text")).not.toBeNull();
    expect(container.querySelector(".kalshi-chart-hover-dot--accuracy")).toBeNull();
    expect(container.querySelector(".kalshi-chart-hover-zone")?.namespaceURI).toBe(
      "http://www.w3.org/2000/svg",
    );
    expect(container.querySelectorAll(".kalshi-table-scroll").length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector('[title*="Paper trade decisions"]')).not.toBeNull();
    expect(container.querySelector('[title*="markets have settled"]')).not.toBeNull();
    expect(container.querySelector('[title*="calibration score"]')).not.toBeNull();
    expect(
      container.querySelector('.kalshi-card__title[title*="Realized simulated profit"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('.kalshi-card__title[title*="percentage of resolved"]'),
    ).not.toBeNull();
    expect(text).not.toMatch(/\bcurrent strategy\b/i);
    expect(text).not.toMatch(/\bcurrent-strategy\b/i);
    expect(text).not.toMatch(/\binverse strategy\b/i);
    expect(text).not.toMatch(/\binverse-first\b/i);
    expect(text).not.toMatch(/\bold strategy\b/i);
    expect(text).not.toMatch(/\bold baseline\b/i);
  });

  it("renders crypto regime coverage and inverse repair shadow diagnostics", () => {
    const base = createProps();
    const container = document.createElement("div");

    render(
      renderKalshiDashboard({
        ...base,
        snapshot: {
          ...base.snapshot,
          sts_crypto_regime_selector: {
            candidate_experiment_count: 2,
            paused_forward_regime_count: 1,
            regime_count: 8,
            live_order_allowed: false,
          },
          sts_crypto_regime_selector_outcomes: {
            forward_recorded_resolved_count: 23,
            forward_recorded_pending_count: 8,
            forward_recorded_due_pending_count: 1,
            forward_recorded_coverage_probe_resolved_count: 15,
            forward_recorded_coverage_probe_pending_count: 8,
            forward_recorded_coverage_probe_due_count: 1,
            forward_recorded_inverse_repair_shadow_resolved_count: 3,
            forward_recorded_inverse_repair_shadow_pending_count: 2,
            forward_recorded_inverse_repair_shadow_due_count: 1,
            inverse_repair_shadow_proof_gate: {
              status: "waiting_for_inverse_repair_shadow_outcomes",
              resolved_count: 3,
              pending_count: 2,
              target_resolved_shadow_outcomes: 10,
              paper_pnl_usd: -1.25,
              accuracy: 0.667,
              blockers: ["inverse_repair_shadow_sample_too_small"],
              next_action:
                "Wait for inverse-repair shadow outcomes until at least 10 source-backed rows are resolved.",
              counts_for_live_readiness: false,
              can_authorize_trade: false,
              live_order_allowed: false,
            },
            coverage_probe_failure_cohort_blocks: [
              {
                coverage_cohort_key: "coverage_cohort:side=no|hour=18",
                resolved_count: 5,
                loss_count: 4,
                paper_pnl_usd: -2.5,
                action: "STS_COVERAGE_PROBE_COHORT_BLOCK",
                counts_for_live_readiness: false,
              },
            ],
            live_order_allowed: false,
          },
          sts_crypto_regime_inverse_repair: {
            repair_count: 1,
            scanned_forward_regime_outcome_count: 31,
            repairs: [
              {
                regime_id: "regime:asset=SOL|side=no|prob=mid_prob|market=balanced",
                recommended_action: "test_inverse_forward_shadow",
                selected_paper_pnl_usd: -5.19,
                inverse_paper_pnl_usd: 4.99,
                abstain_pnl_uplift_usd: 5.19,
                blockers: ["shadow_only_until_forward_inverse_repair_resolves"],
              },
            ],
            live_order_allowed: false,
          },
        },
      }),
      container,
    );

    const text = container.textContent ?? "";
    expect(text).toContain("Coverage probe cohort blocks");
    expect(text).toMatch(/15\s+resolved ·\s+8\s+pending ·\s+1\s+due · 1 blocked cohorts/);
    expect(text).toContain("coverage cohort:side=no|hour=18");
    expect(text).toContain("STS COVERAGE PROBE COHORT BLOCK");
    expect(text).toContain("Inverse repair shadow proof");
    expect(text).toMatch(/3\s+resolved ·\s+2\s+pending ·\s+1\s+due · zero-exposure/);
    expect(text).toContain("waiting for inverse repair shadow outcomes");
    expect(text).toMatch(/3\/10\s+resolved/);
    expect(text).toContain("inverse repair shadow sample too small");
    expect(text).toContain("regime:asset=SOL|side=no|prob=mid prob|market=balanced");
    expect(text).toContain("test inverse forward shadow");
    expect(text).toContain("no live-readiness credit");
  });

  it("shows a delta cell for every Strategy Cockpit row", () => {
    const container = document.createElement("div");

    render(renderKalshiDashboard(createProps()), container);

    const strategyTable = container.querySelector(
      'table[aria-label="Strategy comparison cockpit"]',
    );
    const rows = [...(strategyTable?.querySelectorAll("tbody tr") ?? [])];
    const rowText = rows.map((row) => row.textContent ?? "");

    expect(rows).toHaveLength(6);
    expect(rowText.find((text) => text.includes("Standard Strategy"))).toContain("+$0.00");
    expect(rowText.find((text) => text.includes("Standard Strategy"))).toContain("baseline");
    expect(rowText.find((text) => text.includes("Inverse Standard Strategy"))).toContain("+$22.50");
    expect(rowText.find((text) => text.includes("Inverse Standard Strategy"))).toContain(
      "actual vs Standard",
    );
    expect(rowText.find((text) => text.includes("Source Lag Surface"))).toContain("+$5.50");
    expect(rowText.find((text) => text.includes("Weather Arbitrage Strategy"))).toContain("n/a");
    expect(rowText.find((text) => text.includes("Weather Arbitrage Strategy"))).toContain(
      "waiting for scored proof",
    );
  });

  it("sorts Strategy Cockpit rows and reports strategy-specific metrics", () => {
    const container = document.createElement("div");
    const props = createProps();
    const snapshot = structuredClone(props.snapshot);
    const rows = snapshot?.strategy_comparison?.rows ?? [];
    const polyClawRow = rows[3] ?? {};
    rows[3] = {
      ...polyClawRow,
      accepted: 4,
      shadow_decisions: 2,
      scored: 3,
      accuracy: 0.3333,
      paper_pnl_usd: -14,
      average_pnl_per_scored_trade_usd: -4.6667,
      unresolved: 1,
      domains: { weather: 4, crypto: 2 },
      tracking_status: "tracking",
      next_step: "Compare PolyClaw after more outcomes resolve.",
    };
    props.snapshot = snapshot;
    props.strategySort = "pnl";

    render(renderKalshiDashboard(props), container);

    const text = container.textContent ?? "";
    const strategyRows = [
      ...container.querySelectorAll('table[aria-label="Strategy comparison cockpit"] tbody tr'),
    ];
    expect(strategyRows[0]?.textContent).toContain("PolyClaw");
    expect(strategyRows[0]?.textContent).toContain("-$14.00");
    expect(strategyRows[0]?.textContent).toContain("-$4.00");
    expect(strategyRows[0]?.textContent).toContain("-$4.67");
    expect(strategyRows[0]?.textContent).toContain("weather 4, crypto 2");
    expect(strategyRows[0]?.textContent).toContain("4");
    expect(strategyRows[0]?.textContent).toContain("2 shadow");
    expect(text).not.toContain("PolyClaw P&L Delta");
  });

  it("notifies when the Strategy Cockpit sort changes", () => {
    const container = document.createElement("div");
    const onStrategySortChange = vi.fn();

    render(renderKalshiDashboard(createProps({ onStrategySortChange })), container);

    const select = [...container.querySelectorAll("select")].find(
      (candidate) => candidate.closest(".kalshi-strategy-cockpit") != null,
    );
    expect(select).not.toBeUndefined();
    if (!select) {
      return;
    }
    select.value = "accuracy";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onStrategySortChange).toHaveBeenCalledWith("accuracy");
  });

  it("renders the top milestone countdown with concise scored criteria", () => {
    const container = document.createElement("div");

    render(renderKalshiDashboard(createProps({ showDeepAudit: false })), container);

    const ticker = container.querySelector(".kalshi-countdown-ticker");
    expect(ticker).not.toBeNull();
    const text = ticker?.textContent?.replace(/\s+/g, " ") ?? "";
    expect(text).toContain("Proof Milestones");
    expect(text).toContain("Proof");
    expect(text).toContain("2d 3h 4m");
    expect(text).toContain("Count 3/10");
    expect(text).toContain("Crypto");
    expect(text).toContain("Waiting");

    const pageText = container.textContent ?? "";
    expect(pageText.indexOf("Proof Milestones")).toBeGreaterThan(
      pageText.indexOf("STS Domain Learning Command Center"),
    );

    const chips = [...container.querySelectorAll(".kalshi-countdown-chip")];
    expect(chips.length).toBeGreaterThan(0);
    for (const chip of chips) {
      const chipText = (chip.textContent ?? "").replace(/\s+/g, " ").trim();
      const match = chipText.match(/^(.+?) ([0-9]+(?:\.[0-9])?)\/10$/);
      expect(match, chipText).not.toBeNull();
      if (!match) {
        continue;
      }
      expect(match[1].split(/\s+/).length).toBeLessThanOrEqual(2);
      const score = Number(match[2]);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(10);
    }
  });

  it("renders Weather/Crypto promotion-gap diagnostics without enabling live trading", () => {
    const container = document.createElement("div");
    const props = createProps({ showDeepAudit: false });
    const baseSnapshot = props.snapshot ?? {};
    props.snapshot = {
      ...baseSnapshot,
      weather_crypto_ml: {
        ok: true,
        status: "shadow_learning_only",
        plain_english: "Weather/crypto ML is enforcing shadow-first learning.",
        accepted_paper_allowed_segment_count: 0,
        domains: {
          weather: { shadow_scored: 12, accepted_scored: 0 },
          crypto: { shadow_scored: 80, accepted_scored: 0 },
        },
        reality_contract: {
          training_eligible: 92,
          quarantined_training: 7,
        },
        promotion_gap: {
          status: "blocked",
          next_action: "Collect targeted shadow labels for the listed near-miss segments.",
          top_blocker: "count",
          allowed_segment_count: 0,
          near_miss_segment_count: 1,
          trainable_rows: 92,
          quarantined_rows: 7,
          blocker_counts: { count: 1, brier: 1 },
          calibration_repair: {
            status: "repair_required",
            top_blocker: "brier",
            next_action: "Repair Brier/calibration first.",
            repair_segment_count: 1,
            candidate_behavior: {
              status: "active",
              crypto_reprice_active: true,
              active_shrink_segment_count: 1,
              probability_rule: "market + (raw - market) * cap",
              weather_label_rule: "Brier wins only",
              accepted_paper_allowed: false,
              live_order_allowed: false,
            },
            segments: [
              {
                segment_key: "crypto|ETH|crypto_price_threshold|no",
                action: "shrink_to_market",
                reason: "Model Brier is worse than the market baseline.",
                shadow_brier_score: 0.2,
                shadow_market_brier_score: 0.15,
                candidate_weight_cap: 0.64,
                accepted_paper_allowed: false,
                live_order_allowed: false,
              },
            ],
            live_order_allowed: false,
            auto_live_promotion_allowed: false,
          },
          segments: [
            {
              segment_key: "weather|HOUSTON|low_temperature|below|yes",
              domain: "weather",
              completion_score: 7.1,
              primary_blocker: "count",
              next_action:
                "Collect segment-specific shadow labels before opening tiny accepted paper.",
              criteria: [
                { label: "Count", score: 0.4, detail: "1/25 shadow labels." },
                { label: "Markets", score: 2, detail: "1/5 unique markets." },
                { label: "Accuracy", score: 10, detail: "1.0 vs 0.8 required." },
              ],
              live_order_allowed: false,
            },
          ],
          live_order_allowed: false,
          auto_live_promotion_allowed: false,
        },
        live_order_allowed: false,
        auto_live_promotion_allowed: false,
      },
    };

    render(renderKalshiDashboard(props), container);

    const text = container.textContent ?? "";
    expect(text).toContain("Weather/Crypto ML");
    expect(text).toContain("0 allowed");
    expect(text).toContain("1 near");
    expect(text).toContain("Collect targeted shadow labels");
    expect(text).toContain("Calibration Repair");
    expect(text).toContain("Repair Brier/calibration first.");
    expect(text).toContain("crypto|ETH|crypto_price_threshold|no");
    expect(text).toContain("shrink to market");
    expect(text).toContain("repriced");
    expect(text).toContain("Brier wins only");
    expect(text).toContain("weather|HOUSTON|low_temperature|below|yes");
    expect(text).toMatch(/Count\s+0\.4\/10/);
    expect(text).not.toContain("Live trading enabled");
  });

  it("keeps Advanced Audit hidden until the user asks for it", () => {
    const container = document.createElement("div");
    const onToggleDeepAudit = vi.fn();

    render(
      renderKalshiDashboard(createProps({ showDeepAudit: false, onToggleDeepAudit })),
      container,
    );

    const text = container.textContent ?? "";
    const topText = text.slice(0, text.indexOf("Advanced Audit"));
    expect(text).toContain("Kalshi Paper Trading");
    expect(text).toContain("Live trading is off");
    expect(text).toContain("What changed?");
    expect(text).toContain("Strategy Cockpit");
    expect(text).toContain("Source Lag Surface");
    expect(text).toContain("Learning lanes");
    expect(text).toContain("Advanced Audit hidden");
    expect(text).toContain("Show Advanced Audit");
    expect(topText).toContain("Overall Route Mix");
    expect(topText).toContain("Weather / Crypto Route Mix");
    expect(topText).toContain("shadow only: 70.0%");
    expect(text).not.toContain("Strategy Comparison Details");
    expect(text).not.toContain("Accuracy and paper profit/loss trend");
    expect(text).not.toContain("Paper Volume Accelerator");
    expect(text).not.toContain("Recent Paper Bets");
    expect(topText).not.toContain("SHADOW_ONLY");
    expect(topText).not.toContain("GAP-01");
    expect(topText).not.toContain("Accepted Proof Age");
    expect(topText).not.toContain("HIGH SPEED");
    expect(topText).not.toContain("Live readiness: BLOCKED");

    const toggle = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Show Advanced Audit"),
    );
    toggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onToggleDeepAudit).toHaveBeenCalledTimes(1);
  });

  it("shows high-speed practice learning in Today", () => {
    const container = document.createElement("div");
    const baseProps = createProps();
    const snapshot = baseProps.snapshot!;

    render(
      renderKalshiDashboard(
        createProps({
          showDeepAudit: false,
          snapshot: {
            ...snapshot,
            self_improvement: {
              ...snapshot.self_improvement,
              metrics: {
                ...snapshot.self_improvement?.metrics,
                scored_decisions_last_1h: 0,
                scored_decisions_last_6h: 0,
                scored_decisions_last_24h: 0,
              },
            },
            learning_velocity: {
              status: "HIGH_SPEED_LEARNING",
              plain_english:
                "Learning is active at high speed through fresh weather/crypto shadow outcomes while accepted-paper proof remains safely gated.",
              latest_learning_age_minutes: 2.25,
              latest_accepted_proof_age_minutes: 3187.3,
              resolved_last_1h: 34,
              shadow_resolved_last_1h: 34,
              proof_metrics_exclude_shadow: true,
              live_order_allowed: false,
            },
          },
        }),
      ),
      container,
    );

    const text = container.textContent ?? "";
    expect(text).toContain("Learning fast");
    expect(text).toContain("34 practice-only results landed in the last hour.");
    expect(text).toContain("34 new learning results");
    expect(text).toContain("Profit proof is stale");
    expect(text).toContain("No new profit proof yet");
    expect(text).toContain("Learning Velocity");
    expect(text).toContain("x1.09");
    expect(text).toContain("accepted +incl. 34 shadow outcomes");
    expect(text).toContain("What changed?");
    expect(text).not.toContain("HIGH SPEED");
    expect(text).not.toContain("Accepted Proof Age");
    expect(text).not.toContain("SHADOW_ONLY");
    expect(text).not.toContain("GAP-01");
  });

  it("translates internal bottleneck terms into plain language with definitions", () => {
    const container = document.createElement("div");
    const baseProps = createProps();
    const snapshot = baseProps.snapshot!;
    const paperVolume = snapshot.paper_volume_accelerator!;
    const rapidLearning = paperVolume.rapid_learning_plan!;
    const losingEvidence =
      "Clean resolved paper trades are profitable only 14.4% of the time with clean net P&L $-562.53.";

    render(
      renderKalshiDashboard(
        createProps({
          snapshot: {
            ...snapshot,
            paper_volume_accelerator: {
              ...paperVolume,
              metrics: {
                ...paperVolume.metrics,
                current_learning_bottleneck: "negative_current_epoch_pnl",
                what_must_happen_next_to_learn_faster: losingEvidence,
              },
              rapid_learning_plan: {
                ...rapidLearning,
                primary_bottleneck: "negative_current_epoch_pnl",
                bottlenecks: [
                  {
                    type: "negative_current_epoch_pnl",
                    severity: "critical",
                    evidence: losingEvidence,
                    fix: "Route accepted paper toward baseline-beating current-epoch segments.",
                  },
                ],
              },
            },
          },
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("Paper trades are losing money in this test period");
    expect(container.textContent).toContain(
      "paper trades with reliable final results are profitable only 14.4% of the time with simulated net profit/loss $-562.53.",
    );
    expect(container.textContent).toContain(
      "Route accepted paper toward segments that beat the comparison baselines in this test period.",
    );
    expect(container.textContent).not.toContain("negative current epoch pnl");
    expect(container.textContent).not.toContain("negative_current_epoch_pnl");
    expect(container.textContent).not.toContain("current epoch");
    expect(container.textContent).not.toContain("clean net P&L");
  });

  it("keeps heavy audit log tables bounded when snapshots contain many rows", () => {
    const container = document.createElement("div");
    const baseProps = createProps();
    const snapshot = baseProps.snapshot!;
    const pendingTrade = snapshot.pending_paper_trades!.trades![0];
    const recentTrade = snapshot.recent_paper_bets!.trades![0];
    const resolvedTrade = snapshot.recent_paper_bets!.latest_resolved_trades![0];

    render(
      renderKalshiDashboard(
        createProps({
          snapshot: {
            ...snapshot,
            pending_paper_trades: {
              ...snapshot.pending_paper_trades,
              count: 65,
              shown: 65,
              trades: Array.from({ length: 65 }, (_, index) => ({
                ...pendingTrade,
                decision_id: `pending-${index}`,
                market_ticker: `KXPENDING-${index}`,
              })),
            },
            recent_paper_bets: {
              ...snapshot.recent_paper_bets,
              count: 65,
              shown: 65,
              trades: Array.from({ length: 65 }, (_, index) => ({
                ...recentTrade,
                decision_id: `recent-${index}`,
                market_ticker: `KXRECENT-${index}`,
              })),
              latest_resolved_trades: Array.from({ length: 65 }, (_, index) => ({
                ...resolvedTrade,
                decision_id: `resolved-${index}`,
                market_ticker: `KXRESOLVED-${index}`,
              })),
            },
          },
        }),
      ),
      container,
    );

    expect(container.textContent).toContain(
      "15 additional upcoming rows are held out of the DOM for dashboard speed.",
    );
    expect(container.textContent).toContain(
      "15 additional recent rows are held out of the DOM for dashboard speed.",
    );
    expect(container.textContent).toContain(
      "15 additional resolved rows are held out of the DOM for dashboard speed.",
    );
    expect(container.textContent).toContain("KXPENDING-49");
    expect(container.textContent).not.toContain("KXPENDING-50");
    expect(container.textContent).toContain("KXRECENT-49");
    expect(container.textContent).not.toContain("KXRECENT-50");
  });

  it("supports audit table paging, search callbacks, and visible CSV export", () => {
    const container = document.createElement("div");
    const onAuditTablePageChange = vi.fn();
    const onAuditTableQueryChange = vi.fn();
    const baseProps = createProps();
    const snapshot = baseProps.snapshot!;
    const pendingTrade = snapshot.pending_paper_trades!.trades![0];

    render(
      renderKalshiDashboard(
        createProps({
          auditTablePages: { pending: 2 },
          auditTableQueries: { pending: "KXPENDING" },
          onAuditTablePageChange,
          onAuditTableQueryChange,
          snapshot: {
            ...snapshot,
            pending_paper_trades: {
              ...snapshot.pending_paper_trades,
              count: 65,
              shown: 65,
              trades: Array.from({ length: 65 }, (_, index) => ({
                ...pendingTrade,
                decision_id: `pending-${index}`,
                market_ticker: `KXPENDING-${index}`,
              })),
            },
          },
        }),
      ),
      container,
    );

    const pendingControls = container.querySelector(".kalshi-audit-controls");
    const pendingSearch = pendingControls?.querySelector("input");
    const previousButton = [...(pendingControls?.querySelectorAll("button") ?? [])].find((button) =>
      button.textContent?.includes("Previous"),
    );
    const csvLink = pendingControls?.querySelector('a[download="kalshi-pending-visible-rows.csv"]');

    expect(container.textContent).toContain("Page 2 / 2");
    expect(container.textContent).toContain("KXPENDING-50");
    expect(container.textContent).not.toContain("KXPENDING-49");
    expect(csvLink?.getAttribute("href")).toContain("data:text/csv");

    pendingSearch!.value = "KXPENDING-64";
    pendingSearch?.dispatchEvent(new Event("input", { bubbles: true }));
    previousButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onAuditTableQueryChange).toHaveBeenCalledWith("pending", "KXPENDING-64");
    expect(onAuditTablePageChange).toHaveBeenCalledWith("pending", 1);
  });

  it("uses server-side audit table page metadata when present", () => {
    const container = document.createElement("div");
    const baseProps = createProps();
    const snapshot = baseProps.snapshot!;
    const pendingTrade = snapshot.pending_paper_trades!.trades![0];

    render(
      renderKalshiDashboard(
        createProps({
          auditTablePages: { pending: 2 },
          auditTableQueries: { pending: "KXPENDING" },
          snapshot: {
            ...snapshot,
            audit_pages: {
              pending: {
                filtered_rows: 65,
                page: 2,
                page_count: 2,
                page_size: 50,
                query: "KXPENDING",
                server_sliced: true,
                shown_rows: 15,
                total_rows: 65,
              },
            },
            pending_paper_trades: {
              ...snapshot.pending_paper_trades,
              count: 65,
              shown: 15,
              trades: Array.from({ length: 15 }, (_, index) => ({
                ...pendingTrade,
                decision_id: `pending-${index + 50}`,
                market_ticker: `KXPENDING-${index + 50}`,
              })),
            },
          },
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("Showing 51-65 of 65 matching rows");
    expect(container.textContent).toContain("Server-paged for speed.");
    expect(container.textContent).toContain("Page 2 / 2");
    expect(container.textContent).toContain("KXPENDING-50");
    expect(container.textContent).toContain("KXPENDING-64");
  });

  it("opens metric definitions when question marks are clicked", () => {
    const container = document.createElement("div");

    render(renderKalshiDashboard(createProps()), container);

    const accuracyTitle = container.querySelector(
      '.kalshi-card__title[title*="percentage of resolved"]',
    );
    const accuracyHelp = accuracyTitle?.querySelector("details");
    const accuracyToggle = accuracyHelp?.querySelector("summary");

    expect(accuracyHelp?.hasAttribute("open")).toBe(false);

    accuracyToggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(accuracyHelp?.hasAttribute("open")).toBe(true);
    expect(accuracyHelp?.textContent).toContain("percentage of resolved directional paper trades");
  });

  it("keeps selected timeframe paper profit/loss consistent with selected timeframe scored trades", () => {
    const container = document.createElement("div");

    render(renderKalshiDashboard(createProps({ pnlTimeframe: "1h" })), container);

    const pnlCards = [...container.querySelectorAll(".kalshi-card")].filter((card) =>
      card.textContent?.includes("Paper profit/loss"),
    );
    const selectedPnlCard = pnlCards.find((card) =>
      card.textContent?.includes("Open or unresolved paper trades are not counted"),
    );

    const selectedPnlText = selectedPnlCard?.textContent?.replace(/\s+/g, " ");
    expect(selectedPnlText).toContain("$0.00");
    expect(selectedPnlText).toContain("1 hour. 0 scored trades in selected window");
    expect(selectedPnlText).not.toContain("-$");
    expect(container.textContent).toContain("No resolved paper trades in this timeframe yet.");
  });

  it("filters the accuracy trend graph when the timeframe changes", () => {
    const container = document.createElement("div");
    const base = createProps();
    const snapshot = {
      ...base.snapshot!,
      generated_at_utc: "2026-05-03T02:08:00Z",
    };

    render(renderKalshiDashboard(createProps({ snapshot, timeframe: "24h" })), container);

    expect(container.textContent).toContain("Timeframe: 24 hours");
    expect(container.textContent).toContain("Learning volume: 8 scored trades");
    expect(container.textContent).toContain("Trade 8");

    render(renderKalshiDashboard(createProps({ snapshot, timeframe: "1h" })), container);

    expect(container.textContent).toContain("Timeframe: 1 hour");
    expect(container.textContent).toContain("Paper decisions: 12");
    expect(container.textContent).toContain("Accepted paper trades: 2");
    expect(container.textContent).toContain("Scored accepted trades: 0");
    expect(container.textContent).toContain("learning-speed bottleneck");
    expect(container.textContent).not.toContain("Trade 8");
  });

  it("filters the accuracy trend graph for every timeframe option", () => {
    const container = document.createElement("div");
    const base = createProps();
    const anchor = "2026-05-03T12:00:00Z";
    const makePoint = (index: number, hoursAgo: number) => {
      const timestamp = new Date(Date.parse(anchor) - hoursAgo * 60 * 60 * 1000)
        .toISOString()
        .replace(".000Z", "Z");
      return {
        index,
        timestamp_utc: timestamp,
        scored_at_utc: timestamp,
        accuracy: index / 10,
        cumulative_pnl_usd: index,
        latest_trade_pnl_usd: 1,
      };
    };
    const snapshot = {
      ...base.snapshot!,
      generated_at_utc: anchor,
      strategy_scorecard: {
        ...base.snapshot!.strategy_scorecard!,
        trend: {
          ...base.snapshot!.strategy_scorecard!.trend!,
          points: [
            makePoint(1, 0.5),
            makePoint(2, 5),
            makePoint(3, 10),
            makePoint(4, 20),
            makePoint(5, 36),
            makePoint(6, 120),
            makePoint(7, 480),
            makePoint(8, 2000),
          ],
        },
      },
    };
    const expected = [
      ["1h", "1 hour", 1, "Trade 1", "Trade 2"],
      ["6h", "6 hours", 2, "Trade 2", "Trade 3"],
      ["12h", "12 hours", 3, "Trade 3", "Trade 4"],
      ["24h", "24 hours", 4, "Trade 4", "Trade 5"],
      ["48h", "48 hours", 5, "Trade 5", "Trade 6"],
      ["7d", "1 week", 6, "Trade 6", "Trade 7"],
      ["30d", "1 month", 7, "Trade 7", "Trade 8"],
      ["1y", "1 year", 8, "Trade 8", null],
      ["all", "All", 8, "Trade 8", null],
    ] as const;

    for (const [timeframe, label, count, includedTrade, excludedTrade] of expected) {
      render(renderKalshiDashboard(createProps({ snapshot, timeframe })), container);

      expect(container.textContent).toContain(`Timeframe: ${label}`);
      expect(container.textContent).toContain(`Learning volume: ${count} scored trade`);
      expect(container.textContent).toContain(includedTrade);
      if (excludedTrade) {
        expect(container.textContent).not.toContain(excludedTrade);
      }
    }
  });

  it("uses scored-at time for recent learning trend windows", () => {
    const container = document.createElement("div");
    const base = createProps();
    const snapshot = {
      ...base.snapshot!,
      generated_at_utc: "2026-05-05T12:30:00Z",
      strategy_scorecard: {
        ...base.snapshot!.strategy_scorecard!,
        trend: {
          ...base.snapshot!.strategy_scorecard!.trend!,
          points: [
            {
              index: 1,
              timestamp_utc: "2026-05-03T00:00:00Z",
              scored_at_utc: "2026-05-05T12:00:00Z",
              accuracy: 1,
              cumulative_pnl_usd: 1.25,
              latest_trade_pnl_usd: 1.25,
            },
          ],
        },
      },
    };

    render(renderKalshiDashboard(createProps({ snapshot, timeframe: "1h" })), container);

    expect(container.textContent).toContain("Timeframe: 1 hour");
    expect(container.textContent).toContain("Learning volume: 1 scored trade");
    expect(container.textContent).toContain("Trade 1");
    expect(container.textContent).not.toContain("No scored paper trades fall inside");
  });

  it("opens decision quality and live-readiness funnel term definitions", () => {
    const container = document.createElement("div");

    render(renderKalshiDashboard(createProps()), container);

    const noTradeLabel = container.querySelector(
      '.kalshi-bar-label[title*="intentionally skipped"]',
    );
    const observedLabel = container.querySelector(
      '.kalshi-bar-label[title*="market and orderbook snapshots"]',
    );
    const noTradeHelp = noTradeLabel?.querySelector("details");
    const observedHelp = observedLabel?.querySelector("details");

    noTradeHelp
      ?.querySelector("summary")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    observedHelp
      ?.querySelector("summary")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(noTradeHelp?.hasAttribute("open")).toBe(true);
    expect(noTradeHelp?.textContent).toContain("skipped a paper trade");
    expect(observedHelp?.hasAttribute("open")).toBe(true);
    expect(observedHelp?.textContent).toContain("snapshots collected for analysis");
    expect(noTradeHelp?.querySelector(".kalshi-help__popover")).not.toBeNull();
  });

  it("calls refresh when requested", () => {
    const onRefresh = vi.fn();
    const container = document.createElement("div");

    render(renderKalshiDashboard(createProps({ onRefresh })), container);
    container.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("keeps the refresh button available and disabled while loading", () => {
    const container = document.createElement("div");

    render(renderKalshiDashboard(createProps({ loading: true })), container);

    const refresh = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Refresh Kalshi dashboard"]',
    );
    expect(refresh).not.toBeNull();
    expect(refresh?.disabled).toBe(true);
    expect(refresh?.textContent).toContain("Refreshing...");
  });

  it("changes timezone, trend timeframe, and P&L timeframe from dashboard controls", () => {
    const onTimezoneChange = vi.fn();
    const onTimeframeChange = vi.fn();
    const onPnlTimeframeChange = vi.fn();
    const container = document.createElement("div");

    render(
      renderKalshiDashboard(
        createProps({ onTimezoneChange, onTimeframeChange, onPnlTimeframeChange }),
      ),
      container,
    );

    const selects = [...container.querySelectorAll("select")];
    const timezone = selects.find((select) =>
      [...select.options].some((option) => option.value === "America/Chicago"),
    );
    const timeframe = selects.find((select) =>
      [...select.options].some((option) => option.value === "7d"),
    );

    expect(timezone).not.toBeUndefined();
    expect(timeframe).not.toBeUndefined();
    if (!timezone || !timeframe) {
      throw new Error("Expected timezone and timeframe controls to render");
    }

    timezone.value = "America/Chicago";
    timezone.dispatchEvent(new Event("change", { bubbles: true }));
    timeframe.value = "7d";
    timeframe.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onTimezoneChange).toHaveBeenCalledWith("America/Chicago");
    expect(onTimeframeChange).toHaveBeenCalledWith("7d");

    const sixHourPnl = [...container.querySelectorAll(".kalshi-chip")].find(
      (button) => button.textContent?.trim() === "6 hours",
    );
    sixHourPnl?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onPnlTimeframeChange).toHaveBeenCalledWith("6h");
  });
});
