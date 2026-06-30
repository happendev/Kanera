import type { OnInit} from "@angular/core";
import { Directive, ElementRef, inject } from "@angular/core";

@Directive({ selector: "[autofocus]", standalone: true })
export class AutofocusDirective implements OnInit {
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);

  ngOnInit() {
    setTimeout((): void => {
      this.el.nativeElement.focus();
    });
  }
}
