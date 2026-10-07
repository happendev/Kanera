import type { Type } from "@angular/core";
import type { ComponentFixture, TestComponentOptions } from "@angular/core/testing";
import { TestBed } from "@angular/core/testing";

export interface HtmlComponentFixture<T> extends ComponentFixture<T> {
  readonly nativeElement: HTMLElement;
}

/** Keep Angular's untyped renderer host from making DOM queries and assertions untyped too. */
export function createComponentFixture<T>(component: Type<T>, options?: TestComponentOptions): HtmlComponentFixture<T> {
  const fixture = TestBed.createComponent(component, options);
  const host: unknown = fixture.nativeElement;
  // Angular supports non-browser renderers. These component tests use the browser DOM, so check
  // that assumption at the boundary instead of asserting a host type in every individual test.
  if (!(host instanceof HTMLElement)) throw new Error("Expected an HTML component fixture host");
  return fixture as HtmlComponentFixture<T>;
}
