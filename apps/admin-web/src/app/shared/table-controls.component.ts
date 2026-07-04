import { ChangeDetectionStrategy, Component, input, output } from "@angular/core";

@Component({
  selector: "a-table-controls",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="table-controls">
      <div class="search-wrap">
        <i class="ti ti-search"></i>
        <input class="input" type="search" [attr.placeholder]="placeholder()" [value]="query()" (input)="queryChange.emit($any($event.target).value)" />
        @if (query()) { <button class="clear" type="button" aria-label="Clear search" (click)="queryChange.emit('')"><i class="ti ti-x"></i></button> }
      </div>
    </div>
  `,
  styles: [`
    .table-controls{display:flex;align-items:center;gap:12px;margin:0 0 12px}.search-wrap{position:relative;min-width:240px;max-width:340px;flex:1}.search-wrap>.ti-search{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--text-muted)}.search-wrap .input{width:100%;padding-left:32px;padding-right:32px}.clear{position:absolute;right:5px;top:50%;transform:translateY(-50%);border:0;background:none;color:var(--text-muted);cursor:pointer;padding:5px}@media(max-width:700px){.search-wrap{max-width:none}}
  `],
})
export class TableControlsComponent {
  readonly query = input(""); readonly placeholder = input("Search…"); readonly page = input(1); readonly pageSize = input(25); readonly total = input(0); readonly loading = input(false);
  readonly queryChange = output<string>(); readonly pageChange = output<number>(); readonly pageSizeChange = output<number>();
  readonly sizes = [25, 50, 100];
  pages(): number { return Math.max(1, Math.ceil(this.total() / this.pageSize())); }
  rangeLabel(): string { if (!this.total()) return "0 results"; const start = (this.page() - 1) * this.pageSize() + 1; return `${start}–${Math.min(start + this.pageSize() - 1, this.total())} of ${this.total()}`; }
}

@Component({selector:"a-table-pager",standalone:true,changeDetection:ChangeDetectionStrategy.OnPush,template:`<div class="pager"><span class="muted">{{rangeLabel()}}</span><label class="muted">Rows <select class="select" [value]="pageSize()" (input)="pageSizeChange.emit(+$any($event.target).value)">@for(size of sizes;track size){<option [value]="size" [selected]="size===pageSize()">{{size}}</option>}</select></label><button class="btn btn-sm" type="button" aria-label="Previous page" [disabled]="loading()||page()<=1" (click)="pageChange.emit(page()-1)"><i class="ti ti-chevron-left"></i></button><span class="muted">Page {{page()}} of {{pages()}}</span><button class="btn btn-sm" type="button" aria-label="Next page" [disabled]="loading()||page()>=pages()" (click)="pageChange.emit(page()+1)"><i class="ti ti-chevron-right"></i></button></div>`,styles:[`.pager{display:flex;align-items:center;justify-content:flex-start;gap:8px;margin-top:12px;font-size:12px;flex-wrap:wrap}.pager label{display:flex;align-items:center;gap:6px}.pager .select{padding:5px 24px 5px 7px;font-size:12px}`]})
export class TablePagerComponent{readonly page=input(1);readonly pageSize=input(25);readonly total=input(0);readonly loading=input(false);readonly pageChange=output<number>();readonly pageSizeChange=output<number>();readonly sizes=[25,50,100];pages(){return Math.max(1,Math.ceil(this.total()/this.pageSize()))}rangeLabel(){if(!this.total())return"0 results";const start=(this.page()-1)*this.pageSize()+1;return`${start}–${Math.min(start+this.pageSize()-1,this.total())} of ${this.total()}`}}
