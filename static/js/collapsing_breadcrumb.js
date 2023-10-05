jQuery(function () {
    jQuery(".breadcrumb:not(.no-collapse-breadcrumb)").map(function (idx, breadcrumb) {
      var breadcrumb = jQuery(breadcrumb);
      
      if (breadcrumb.children().length >= 5) {
        var detached_children = breadcrumb.children().slice(1, -1).detach();
        
        var expand_breadcrumb = jQuery('<li><a href="" title="Show all breadcrumbs">/ ... /</a></li>');
        
        expand_breadcrumb.on("click", function (event) {
          event.preventDefault();
          breadcrumb.children().slice(1, -1).remove();
          breadcrumb.children().first().after(detached_children);
        });
        breadcrumb.children().first().after(expand_breadcrumb);
      }
    }); 
  });