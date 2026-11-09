import { Module, type DynamicModule } from '@nestjs/common';
import { InvestigationService } from '../application/investigate.js';
import { FixtureModel } from '../adapters/fixture-model.js';
import { LocalGitReader } from '../adapters/local-git-reader.js';
import { LocalReportSink } from '../adapters/local-report-sink.js';
import { SqliteTaskStore } from '../adapters/sqlite-task-store.js';
import type { IngestionPolicy, RepositoryPolicy } from '../domain/types.js';
import { JsonModelOutputValidator } from '../policy/model-output.js';
import { join } from 'node:path';

export interface WorkerOptions {
  command: 'replay' | 'inspect' | 'list';
  sourceRoot: string;
  dataDirectory: string;
  scenario: string;
  fixturePath: string;
  repository: RepositoryPolicy;
  ingestion: IngestionPolicy;
  taskId: string;
}

export const TASK_STORE = Symbol('TaskStore');
export const REPORT_SINK = Symbol('ReportSink');

@Module({})
export class HarnessModule {
  static configure(options: WorkerOptions): DynamicModule {
    const ingestionScenarios = ['duplicate', 'no-mention', 'other-user', 'disallowed-channel', 'other-workspace', 'edited', 'deleted', 'bot', 'self', 'redaction'];
    const modelScenario = ingestionScenarios.includes(options.scenario) ? 'inquiry' : options.scenario;
    return {
      module: HarnessModule,
      providers: [
        { provide: TASK_STORE, useFactory: () => new SqliteTaskStore(join(options.dataDirectory, 'tasks.sqlite')) },
        { provide: REPORT_SINK, useFactory: () => new LocalReportSink(join(options.dataDirectory, 'reports')) },
        {
          provide: InvestigationService,
          inject: [TASK_STORE, REPORT_SINK],
          useFactory: (store: SqliteTaskStore, reporter: LocalReportSink) => new InvestigationService(
            options.ingestion, options.repository, new FixtureModel(modelScenario),
            new JsonModelOutputValidator(), new LocalGitReader(options.repository), store, reporter,
          ),
        },
      ],
    };
  }
}
