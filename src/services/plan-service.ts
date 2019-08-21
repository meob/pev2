import * as _ from 'lodash';
import {EstimateDirection, NodeProp, WorkerProp} from '@/enums';
import { IPlan } from '@/iplan';
import Node from '@/inode';
import Worker from '@/iworker';
import moment from 'moment';

export class PlanService {

  private static instance: PlanService;


  private maxRows: number = 0;
  private maxCost: number = 0;
  private maxDuration: number = 0;

  public createPlan(planName: string, planContent: any, planQuery: string): IPlan {
    // remove any extra white spaces in the middle of query
    // (\S) start match after any non-whitespace character => group 1
    // (?!$) don't start match after end of line
    // (\s{2,}) group of 2 or more white spaces
    // '$1 ' reuse group 1 and and a single space
    planQuery = planQuery.replace(/(\S)(?!$)(\s{2,})/gm, '$1 ');

    const plan: IPlan = {
      id: NodeProp.PEV_PLAN_TAG + new Date().getTime().toString(),
      name: planName || 'plan created on ' + moment().format('LLL'),
      createdOn: new Date(),
      content: planContent,
      query: planQuery,
      planStats: {},
    };

    this.analyzePlan(plan);
    return plan;
  }

  public analyzePlan(plan: IPlan) {
    this.processNode(plan.content.Plan);
    plan.content[NodeProp.MAXIMUM_ROWS] = this.maxRows;
    plan.content[NodeProp.MAXIMUM_COSTS] = this.maxCost;
    plan.content[NodeProp.MAXIMUM_DURATION] = this.maxDuration;

    this.findOutlierNodes(plan.content.Plan, plan);
  }

  // recursively walk down the plan to compute various metrics
  public processNode(node: any) {
    this.calculatePlannerEstimate(node);

    _.each(node[NodeProp.PLANS], (val) => {
      this.processNode(val);
    });

    // calculate actuals after processing child nodes so that actual duration
    // takes loops into account
    this.calculateActuals(node);

    _.each(node, (value, key) => {
      this.calculateMaximums(node, key, value);
    });
  }

  public calculateMaximums(node: any, key: string, value: number) {
    if (key === NodeProp.ACTUAL_ROWS && this.maxRows < value) {
      this.maxRows = value;
    }
    if (key === NodeProp.ACTUAL_COST && this.maxCost < value) {
      this.maxCost = value;
    }

    if (key === NodeProp.ACTUAL_DURATION && this.maxDuration < value) {
      this.maxDuration = value;
    }
  }

  public findOutlierNodes(node: any, root: any) {
    if (node[NodeProp.ACTUAL_COST] === this.maxCost) {
      node[NodeProp.COSTLIEST_NODE] = true;
    }
    if (node[NodeProp.ACTUAL_ROWS] === this.maxRows && node[NodeProp.ACTUAL_ROWS] !== 0) {
      node[NodeProp.LARGEST_NODE] = true;
    }
    if (node[NodeProp.ACTUAL_DURATION] === this.maxDuration) {
      node[NodeProp.SLOWEST_NODE] = true;
    }

    _.each(node, (value, key) => {
      if (key === NodeProp.PLANS) {
        _.each(value, (val) => {
          this.findOutlierNodes(val, root);
        });
      }
    });
  }

  // actual duration and actual cost are calculated by subtracting child values from the total
  public calculateActuals(node: any) {
    if (node[NodeProp.ACTUAL_TOTAL_TIME]) {
      node[NodeProp.ACTUAL_DURATION] = node[NodeProp.ACTUAL_TOTAL_TIME];
      // since time is reported for an invidual loop, actual duration must be adjusted by number of loops
      // unless the current node is parallel aware
      // or has workers (which is the case for Sort nodes in parallel queries)
      if (!node[NodeProp.PARALLEL_AWARE] && !node[NodeProp.WORKERS]) {
        node[NodeProp.ACTUAL_DURATION] = node[NodeProp.ACTUAL_DURATION] * node[NodeProp.ACTUAL_LOOPS];
      }

      node[NodeProp.ACTUAL_DURATION] = node[NodeProp.ACTUAL_DURATION] - this.childrenDuration(node, 0);
    }

    if (node[NodeProp.TOTAL_COST]) {
      node[NodeProp.ACTUAL_COST] = node[NodeProp.TOTAL_COST];
    }


    _.each(node[NodeProp.PLANS], (subPlan) => {
      if (subPlan[NodeProp.PARENT_RELATIONSHIP] !== 'InitPlan' && subPlan[NodeProp.TOTAL_COST]) {
        node[NodeProp.ACTUAL_COST] = node[NodeProp.ACTUAL_COST] - subPlan[NodeProp.TOTAL_COST];
      }
    });

    if (node[NodeProp.ACTUAL_COST] < 0) {
      node[NodeProp.ACTUAL_COST] = 0;
    }
  }

  // recursive function to get the sum of actual durations of a a node children
  public childrenDuration(node: Node, duration: number) {
    _.each(node[NodeProp.PLANS], (subPlan) => {
      // Subtract sub plans duration from this node except for InitPlans
      // (ie. CTE)
      if (subPlan[NodeProp.PARENT_RELATIONSHIP] !== 'InitPlan') {
        duration += subPlan[NodeProp.ACTUAL_DURATION] || 0; // Duration may not be set
        duration = this.childrenDuration(subPlan, duration);
      }
    });
    return duration;
  }

  // figure out order of magnitude by which the planner mis-estimated how many rows would be
  // invloved in this node
  public calculatePlannerEstimate(node: any) {
    if (!node[NodeProp.ACTUAL_ROWS]) {
      return;
    }
    node[NodeProp.PLANNER_ESTIMATE_FACTOR] = node[NodeProp.ACTUAL_ROWS] / node[NodeProp.PLAN_ROWS];
    node[NodeProp.PLANNER_ESTIMATE_DIRECTION] = EstimateDirection.none;

    if (node[NodeProp.PLANNER_ESTIMATE_FACTOR] > 1) {
      node[NodeProp.PLANNER_ESTIMATE_DIRECTION] = EstimateDirection.under;
    }
    if (node[NodeProp.PLANNER_ESTIMATE_FACTOR] < 1) {
      node[NodeProp.PLANNER_ESTIMATE_DIRECTION] = EstimateDirection.over;
      node[NodeProp.PLANNER_ESTIMATE_FACTOR] = node[NodeProp.PLAN_ROWS] / node[NodeProp.ACTUAL_ROWS];
    }
  }

  public fromSource(source: string) {
    // remove quotes added by pgAdmin3
    source = source.replace(/^(["'])(.*)\1\r?\n/gm, '$2\n');
    // remove + character at the end of line added by default psql config
    source = source.replace(/\s*\+\r?\n/g, '\n');

    if (/^(\s*)(\[|\{)\s*\n.*?\1(\]|\})\s*/gms.exec(source)) {
      return this.fromJson(source);
    }
    return this.fromText(source);
  }

  public fromJson(source: string) {
    // We need to remove things before and/or after explain
    // To do this, first - split explain into lines...
    const sourceLines = source.split(/[\r\n]+/);

    // Now, find first line of explain, and cache it's prefix (some spaces ...)
    let prefix = '';
    let firstLineIndex = 0;
    _.each(sourceLines, (l: string, index: number) => {
      const matches = /^(\s*)(\[|\{)\s*$/.exec(l);
      if (matches) {
        prefix = matches[1];
        firstLineIndex = index;
        return false;
      }
    });
    // now find last line
    let lastLineIndex = 0;
    _.each(sourceLines, (l: string, index: number) => {
      const matches = new RegExp('^' + prefix + '(\]|\})\s*$').exec(l);
      if (matches) {
        lastLineIndex = index;
        return false;
      }
    });

    const useSource: string = sourceLines.slice(firstLineIndex, lastLineIndex + 1).join('\n');

    let planJson = JSON.parse(useSource);
    if (planJson instanceof Array) {
      planJson = planJson[0];
    }
    return planJson;
  }

  public fromText(text: string) {

    const lines = text.split(/\r?\n/);

    const root: any = {};
    root.Plan = null;
    type ElementAtDepth = [number, any];
    // Array to keep reference to previous nodes with there depth
    const elementsAtDepth: ElementAtDepth[] = [];

    _.each(lines, (line: string) => {
      // Remove any trailing "
      line = line.replace(/"\s*$/, '');
      // Remove any begining "
      line = line.replace(/^\s*"/, '');

      const prefixRegex = '^(?<prefix>\\s*->\\s*|\\s*)';
      const typeRegex = '(?<type>\\S.*?)\\s+';
      // tslint:disable-next-line:max-line-length
      const estimationRegex = '\\(cost=(?<estimated_startup_cost>\\d+\\.\\d+)\\.\\.(?<estimated_total_cost>\\d+\\.\\d+)\\s+rows=(?<estimated_rows>\\d+)\\s+width=(?<estimated_row_width>\\d+)\\)';
      const nonCapturingGroupOpen = '(?:';
      const nonCapturingGroupClose = ')';
      const openParenthesisRegex = '\\(';
      const closeParenthesisRegex = '\\)';
      // tslint:disable-next-line:max-line-length
      const actualRegex = '(?:actual\\stime=(?<actual_time_first>\\d+\\.\\d+)\\.\\.(?<actual_time_last>\\d+\\.\\d+)\\srows=(?<actual_rows>\\d+)\\sloops=(?<actual_loops>\\d+)|actual\\srows=(?<actual_rows_>\\d+)\\sloops=(?<actual_loops_>\\d+)|(?<never_executed>never\\s+executed))';
      const optionalGroup = '?';

      /*
       * Groups
       * 1: prefix
       * 2: type
       * 3: estimated_startup_cost
       * 4: estimated_total_cost
       * 5: estimated_rows
       * 6: estimated_row_width
       * 7: actual_time_first
       * 8: actual_time_last
       * 9: actual_rows
       * 10: actual_loops
       * 11: actual_rows_
       * 12: actual_loops_
       * 13: never_executed
       */
      const nodeRegex = new RegExp(
        prefixRegex +
        typeRegex +
        estimationRegex +
        '\\s*' +
        nonCapturingGroupOpen +
        '\\s+' +
        openParenthesisRegex +
        actualRegex +
        closeParenthesisRegex +
        nonCapturingGroupClose +
        optionalGroup +
        '\\s*$',
        'gm',
      );
      const nodeMatches = nodeRegex.exec(line);

      // tslint:disable-next-line:max-line-length
      const subRegex = /^(\s*)((?:Sub|Init)Plan)\s*(?:\d+\s*)?\s*(?:\(returns.*\)\s*)?$/gm;
      const subMatches = subRegex.exec(line);

      const cteRegex = /^(\s*)CTE\s+(\S+)\s*$/g;
      const cteMatches = cteRegex.exec(line);

      /*
       * Groups
       * 2: trigger name
       * 3: time
       * 4: calls
       */
      const triggerRegex = /^(\s*)Trigger\s+(.*):\s+time=(\d+\.\d+)\s+calls=(\d+)\s*$/g;
      const triggerMatches = triggerRegex.exec(line);

      /*
       * Groups
       * 2: Worker number
       * 3: actual_time_first
       * 4: actual_time_last
       * 5: actual_rows
       * 6: actual_loops
       * 7: actual_rows_
       * 8: actual_loops_
       * 9: never_executed
       * 10: extra
       */
      const workerRegex = new RegExp(
        /^(\s*)Worker\s+(\d+):\s+/.source +
        nonCapturingGroupOpen +
        actualRegex +
        nonCapturingGroupClose +
        optionalGroup +
        '(?<extra>.*)' +
        '\\s*$',
        'g',
      );
      const workerMatches = workerRegex.exec(line);

      const extraRegex = /^(\s*)(\S.*\S)\s*$/g;
      const extraMatches = extraRegex.exec(line);

      if (nodeMatches) {
        const prefix = nodeMatches[1];
        const neverExecuted = nodeMatches[13];
        const newNode: Node = new Node(nodeMatches[2]);
        newNode[NodeProp.STARTUP_COST] = parseFloat(nodeMatches[3]);
        newNode[NodeProp.TOTAL_COST] = parseFloat(nodeMatches[4]);
        newNode[NodeProp.PLAN_ROWS] = parseInt(nodeMatches[5], 0);
        if (nodeMatches[7] && nodeMatches[8]) {
          newNode[NodeProp.ACTUAL_STARTUP_TIME] = parseFloat(nodeMatches[7]);
          newNode[NodeProp.ACTUAL_TOTAL_TIME] = parseFloat(nodeMatches[8]);
          // FIXME could be actual_rows_
          newNode[NodeProp.ACTUAL_ROWS] = parseInt(nodeMatches[9], 0);
          // FIXME could be actual_loops_
          newNode[NodeProp.ACTUAL_LOOPS] = parseInt(nodeMatches[10], 0);
        }

        if (neverExecuted) {
          newNode[NodeProp.ACTUAL_LOOPS] = 0;
          newNode[NodeProp.ACTUAL_ROWS] = 0;
          newNode[NodeProp.ACTUAL_TOTAL_TIME] = 0;
        }
        const element = {
          node: newNode,
          subelementType: 'subnode',
        };
        const prefixLength = prefix.split('->')[0].length;

        if (0 === elementsAtDepth.length) {
          elementsAtDepth.push([prefixLength, element]);
          root.Plan = newNode;
          return;
        }

        // Remove elements from elementsAtDepth for deeper levels
        _.remove(elementsAtDepth, (e) => {
          return e[0] >= prefixLength;
        });

        // ! is for non-null assertion
        // Prevents the "Object is possibly 'undefined'" linting error
        const previousElement = _.last(elementsAtDepth)![1];

        elementsAtDepth.push([prefixLength, element]);

        if (!previousElement.node[NodeProp.PLANS]) {
          previousElement.node[NodeProp.PLANS] = [];
        }
        if (previousElement.subelementType === 'initplan' ) {
          newNode[NodeProp.PARENT_RELATIONSHIP] = 'InitPlan';
          newNode[NodeProp.SUBPLAN_NAME] = previousElement.name;
        } else if (previousElement.subelementType === 'subplan' ) {
          newNode[NodeProp.PARENT_RELATIONSHIP] = 'SubPlan';
          newNode[NodeProp.SUBPLAN_NAME] = previousElement.name;
        }
        previousElement.node.Plans.push(newNode);

      } else if (subMatches) {
        const prefix = subMatches[1];
        const type = subMatches[2];
        // Remove elements from elementsAtDepth for deeper levels
        _.remove(elementsAtDepth, (e) => e[0] >= prefix.length);
        const previousElement = _.last(elementsAtDepth)![1];
        const element = {
          node: previousElement.node,
          subelementType: type.toLowerCase(),
          name: subMatches[0],
        };
        const prefixLength = prefix.length;
        elementsAtDepth.push([prefixLength, element]);
      } else if (cteMatches) {
        const prefix = cteMatches[1];
        const cteName = cteMatches[2];
        // Remove elements from elementsAtDepth for deeper levels
        _.remove(elementsAtDepth, (e) => e[0] >= prefix.length);
        const previousElement = _.last(elementsAtDepth)![1];
        const element = {
          node: previousElement.node,
          subelementType: 'initplan',
          name: 'CTE ' + cteName,
        };
        const prefixLength = prefix.length;
        elementsAtDepth.push([prefixLength, element]);
      } else if (workerMatches) {
        const prefix = workerMatches[1];
        const workerNumber = parseInt(workerMatches[2], 0);
        const previousElement = _.last(elementsAtDepth)![1];
        if (!previousElement.node[NodeProp.WORKERS]) {
          previousElement.node[NodeProp.WORKERS] = [];
        }
        let worker = this.getWorker(previousElement.node, workerNumber);
        if (!worker) {
          worker = new Worker(workerNumber);
          previousElement.node[NodeProp.WORKERS].push(worker);
        }
        if (workerMatches[3] && workerMatches[4]) {
          worker[NodeProp.ACTUAL_STARTUP_TIME] = parseFloat(workerMatches[3]);
          worker[NodeProp.ACTUAL_TOTAL_TIME] = parseFloat(workerMatches[4]);
          worker[NodeProp.ACTUAL_ROWS] = parseInt(workerMatches[5], 0);
          worker[NodeProp.ACTUAL_LOOPS] = parseInt(workerMatches[6], 0);
        }
        // extra info (Sort method for example)
        if (workerMatches[10]) {
          const info = workerMatches[10].split(/: (.+)/).filter((x) => x);
          if (!info[1]) {
            return;
          }
          const property = _.startCase(info[0]);
          worker[property] = info[1];
        }
      } else if (triggerMatches) {
        const prefix = triggerMatches[1];
        // Remove elements from elementsAtDepth for deeper levels
        _.remove(elementsAtDepth, (e) => e[0] >= prefix.length);
        root.Triggers = root.Triggers || [];
        root.Triggers.push({
          'Trigger Name': triggerMatches[2],
          'Time': parseFloat(triggerMatches[3].replace(/(\s*ms)$/, '')),
          'Calls': triggerMatches[4],
        });
      } else if (extraMatches) {

        const prefix = extraMatches[1];
        // Remove elements from elementsAtDepth for deeper levels
        _.remove(elementsAtDepth, (e) => e[0] >= prefix.length);

        let element;
        if (elementsAtDepth.length === 0) {
          element = root;
        } else {
          element = _.last(elementsAtDepth)![1].node;
        }

        if (this.parseSort(extraMatches[2], element)) {
          return;
        }

        const info = extraMatches[2].split(/: (.+)/).filter((x) => x);
        if (!info[1]) {
          return;
        }

        // remove the " ms" unit in case of time
        let value: string | number = info[1].replace(/(\s*ms)$/, '');
        // try to convert to number
        if (parseFloat(value)) {
          value = parseFloat(value);
        }

        const property = _.startCase(info[0]);
        element[property] = value;
      }
    });
    if (!root.Plan) {
      throw new Error('Unable to parse plan');
    }
    return root;
  }

  private parseSort(text: string, el: Node | Worker): boolean {
    /*
     * Groups
     * 2: Sort Method
     * 3: Sort Space Type
     * 4: Sort Space Used
     */
    const sortRegex = /^(\s*)Sort Method:\s+(?<method>.*)\s+(?<spacetype>Memory|Disk):\s+(?<spaceused>\S*)\s*$/g;
    const sortMatches = sortRegex.exec(text);
    if (sortMatches) {
      el[NodeProp.SORT_METHOD] = sortMatches[2].trim();
      el[NodeProp.SORT_SPACE_USED] = sortMatches[4];
      el[NodeProp.SORT_SPACE_TYPE] = sortMatches[3];
      return true;
    }
    return false;
  }

  private getWorker(node: Node, workerNumber: number): Worker|null {
    return _.find(node[NodeProp.WORKERS], (worker) => {
      return worker[WorkerProp.WORKER_NUMBER] === workerNumber;
    });
  }
}
