import { ChangeDetectionStrategy, Component, input, output } from "@angular/core";
import { TablePagerComponent } from "./table-controls.component";

export interface DataTableColumn { key: string; label: string; sortable?: boolean }

@Component({
  selector: "a-data-table",
  standalone: true,
  imports: [TablePagerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="search">
      <i class="ti ti-search"></i>
      <input class="input" type="search" [attr.placeholder]="placeholder()" [value]="query()" (input)="changeQuery($any($event.target).value)" />
      @if (query()) {<button type="button" aria-label="Clear search" (click)="changeQuery('')"><i class="ti ti-x"></i></button>}
    </div>
    <div class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            @for (column of columns(); track column.key) {
              <th>
                @if (column.sortable !== false) {
                  <button class="sort" type="button" (click)="sortChange.emit(column.key)">{{ column.label }} @if (sort() === column.key) {<i class="ti" [class.ti-arrow-up]="direction() === 'asc'" [class.ti-arrow-down]="direction() === 'desc'"></i>}</button>
                } @else { {{ column.label }} }
              </th>
            }
          </tr>
        </thead>
        <tbody><ng-content /></tbody>
      </table>
    </div>
    <a-table-pager [page]="page()" [pageSize]="pageSize()" [total]="total()" [loading]="loading()" (pageChange)="pageChange.emit($event)" (pageSizeChange)="pageSizeChange.emit($event)" />
  `,
  styles: [`
    .search{position:relative;max-width:340px;margin-bottom:12px}.search>.ti{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--text-muted)}.search .input{width:100%;padding-left:32px;padding-right:32px}.search>button{position:absolute;right:5px;top:50%;transform:translateY(-50%);border:0;background:none;color:var(--text-muted);cursor:pointer;padding:5px}.table-wrap{overflow-x:auto}.sort{border:0;background:none;padding:0;font:inherit;font-weight:inherit;color:inherit;cursor:pointer;white-space:nowrap}
  `],
})
export class DataTableComponent {
  readonly columns = input.required<readonly DataTableColumn[]>();
  readonly query = input("");
  readonly placeholder = input("Search…");
  readonly sort = input("");
  readonly direction = input<"asc" | "desc">("asc");
  readonly page = input(1);
  readonly pageSize = input(25);
  readonly total = input(0);
  readonly loading = input(false);
  readonly queryChange = output<string>();
  readonly sortChange = output<string>();
  readonly pageChange = output<number>();
  readonly pageSizeChange = output<number>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  // Debounced so each keystroke does not refetch; clearing is immediate so the table resets at once.
  changeQuery(value: string) {
    if (this.timer) clearTimeout(this.timer);
    if (!value) {
      this.queryChange.emit("");
      return;
    }
    this.timer = setTimeout(() => this.queryChange.emit(value), 250);
  }
}
