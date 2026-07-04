import { ChangeDetectionStrategy, Component, input, output } from "@angular/core";

export interface DataTableColumn { key: string; label: string; sortable?: boolean }

@Component({
  selector: "a-data-table",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="search"><i class="ti ti-search"></i><input class="input" type="search" [attr.placeholder]="placeholder()" [value]="query()" (input)="changeQuery($any($event.target).value)"/>@if(query()){<button type="button" aria-label="Clear search" (click)="changeQuery('')"><i class="ti ti-x"></i></button>}</div>
    <div class="table-wrap"><table class="data"><thead><tr>@for(column of columns();track column.key){<th>@if(column.sortable!==false){<button class="sort" type="button" (click)="sortChange.emit(column.key)">{{column.label}} @if(sort()===column.key){<i class="ti" [class.ti-arrow-up]="direction()==='asc'" [class.ti-arrow-down]="direction()==='desc'"></i>}</button>}@else{ {{column.label}} }</th>}</tr></thead><tbody><ng-content /></tbody></table></div>
    <div class="pager"><span class="muted">{{rangeLabel()}}</span><label class="muted">Rows <select class="select" [value]="pageSize()" (input)="pageSizeChange.emit(+$any($event.target).value)">@for(size of sizes;track size){<option [value]="size" [selected]="size===pageSize()">{{size}}</option>}</select></label><button class="btn btn-sm" type="button" aria-label="Previous page" [disabled]="loading()||page()<=1" (click)="pageChange.emit(page()-1)"><i class="ti ti-chevron-left"></i></button><span class="muted">Page {{page()}} of {{pages()}}</span><button class="btn btn-sm" type="button" aria-label="Next page" [disabled]="loading()||page()>=pages()" (click)="pageChange.emit(page()+1)"><i class="ti ti-chevron-right"></i></button></div>
  `,
  styles:[`.search{position:relative;max-width:340px;margin-bottom:12px}.search>.ti{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--text-muted)}.search .input{width:100%;padding-left:32px;padding-right:32px}.search>button{position:absolute;right:5px;top:50%;transform:translateY(-50%);border:0;background:none;color:var(--text-muted);cursor:pointer;padding:5px}.table-wrap{overflow-x:auto}.sort{border:0;background:none;padding:0;font:inherit;font-weight:inherit;color:inherit;cursor:pointer;white-space:nowrap}.pager{display:flex;align-items:center;justify-content:flex-start;gap:8px;margin-top:12px;font-size:12px;flex-wrap:wrap}.pager label{display:flex;align-items:center;gap:6px}.pager .select{padding:5px 24px 5px 7px;font-size:12px}`],
})
export class DataTableComponent {
  readonly columns=input.required<readonly DataTableColumn[]>(); readonly query=input(""); readonly placeholder=input("Search…"); readonly sort=input(""); readonly direction=input<"asc"|"desc">("asc"); readonly page=input(1); readonly pageSize=input(25); readonly total=input(0); readonly loading=input(false);
  readonly queryChange=output<string>(); readonly sortChange=output<string>(); readonly pageChange=output<number>(); readonly pageSizeChange=output<number>(); readonly sizes=[25,50,100]; private timer:ReturnType<typeof setTimeout>|null=null;
  changeQuery(value:string){if(this.timer)clearTimeout(this.timer);if(!value){this.queryChange.emit("");return}this.timer=setTimeout(()=>this.queryChange.emit(value),250)} pages(){return Math.max(1,Math.ceil(this.total()/this.pageSize()))} rangeLabel(){if(!this.total())return"0 results";const start=(this.page()-1)*this.pageSize()+1;return`${start}–${Math.min(start+this.pageSize()-1,this.total())} of ${this.total()}`}
}
